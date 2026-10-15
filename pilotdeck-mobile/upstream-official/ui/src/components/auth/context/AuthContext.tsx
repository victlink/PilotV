import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { IS_PLATFORM, DISABLE_LOCAL_AUTH } from '../../../constants/config';
import { api } from '../../../utils/api';
import { AUTH_ERROR_MESSAGES } from '../constants';
import { clearTokenFor, readTokenFor, writeTokenFor } from '../deviceTokens';
import { activeBackendOrigin } from '../../app-shell/pilotvRuntime';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  GatewayRuntimeState,
  ModelConfigurationState,
  OnboardingStatusPayload,
  RuntimeStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

// PilotV 会把多台设备的后端挂在同一个页面来源下，因此令牌按后端 origin 分开存放。
// 官方 UI 原本只用一个 auth-token，那样切换设备后必然要重新登录。
const readStoredToken = (): string | null => readTokenFor(activeBackendOrigin());

const persistToken = (token: string) => {
  writeTokenFor(activeBackendOrigin(), token);
};

const clearStoredToken = () => {
  clearTokenFor(activeBackendOrigin());
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigurationState>({ state: 'loading' });
  const [gatewayRuntime, setGatewayRuntime] = useState<GatewayRuntimeState>({ state: 'unmanaged' });
  const [error, setError] = useState<string | null>(null);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    setModelConfiguration({ state: 'loading' });
    try {
      const response = await api.user.onboardingStatus();
      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      if (!response.ok) {
        // 401 Unauthorized or auth error means the token is invalid or missing for this backend.
        // Clear the user session to trigger re-authentication instead of showing
        // a confusing "model unavailable" error.
        const errorMsg = payload?.error || '';
        const isAuthError = response.status === 401 ||
          (typeof errorMsg === 'string' && (
            errorMsg.includes('Access denied') ||
            errorMsg.includes('No token') ||
            errorMsg.includes('Invalid token')
          ));
        if (isAuthError) {
          console.warn('[Auth] Auth error on onboarding status - clearing session for re-auth:', errorMsg);
          clearSession();
          setModelConfiguration({
            state: 'status_error',
            error: 'Authentication required. Please log in.',
          });
          return;
        }
        setModelConfiguration({
          state: 'status_error',
          error: errorMsg || 'Failed to check model configuration',
        });
        return;
      }

      if (payload?.configuration) {
        setModelConfiguration(payload.configuration);
        setGatewayRuntime(payload.gateway ?? { state: 'unmanaged' });
        return;
      }

      // Compatibility with older UI servers during rolling upgrades.
      setGatewayRuntime({ state: 'unmanaged' });
      setModelConfiguration(payload?.hasCompletedOnboarding
        ? { state: 'ready', modelRef: '', configPath: null, revision: '' }
        : {
            state: 'needs_configuration',
            reason: 'missing_model',
            configPath: null,
            revision: '',
          });
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      setModelConfiguration({
        state: 'status_error',
        error: caughtError instanceof Error
          ? caughtError.message
          : 'Failed to check model configuration',
      });
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const checkRuntimeStatus = useCallback(async () => {
    try {
      const response = await api.user.runtimeStatus();
      const payload = await parseJsonSafely<RuntimeStatusPayload>(response);
      if (!response.ok) return;
      if (payload?.configuration) setModelConfiguration(payload.configuration);
      if (payload?.gateway) setGatewayRuntime(payload.gateway);
    } catch (caughtError) {
      console.error('Error checking runtime status:', caughtError);
    }
  }, []);

  useEffect(() => {
    if (
      (modelConfiguration.state !== 'ready' && modelConfiguration.state !== 'empty')
      || gatewayRuntime.state === 'unmanaged'
      || gatewayRuntime.state === 'error'
    ) {
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        await checkRuntimeStatus();
        if (!cancelled) poll();
      }, gatewayRuntime.state === 'ready' ? 3_000 : 500);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [checkRuntimeStatus, gatewayRuntime.state, modelConfiguration.state]);

  const retryGateway = useCallback(async () => {
    setGatewayRuntime({ state: 'starting' });
    try {
      const response = await api.user.retryGateway();
      const payload = await parseJsonSafely<{ error?: string }>(response);
      if (!response.ok) {
        setGatewayRuntime({
          state: 'error',
          error: payload?.error || 'Failed to restart Gateway',
        });
        return;
      }
      await checkRuntimeStatus();
    } catch (caughtError) {
      setGatewayRuntime({
        state: 'error',
        error: caughtError instanceof Error ? caughtError.message : 'Failed to restart Gateway',
      });
    }
  }, [checkRuntimeStatus]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.authDisabled) {
        setUser({ username: 'local' });
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return;
      }

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      if (!token) {
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, token]);

  // Re-read token when backend origin changes (e.g., device switch in PilotV).
  // Each remote device has its own token stored in deviceTokens.
  const prevBackendRef = useRef<string | null>(null);
  useEffect(() => {
    const currentBackend = activeBackendOrigin();
    if (prevBackendRef.current === currentBackend) return;
    prevBackendRef.current = currentBackend;

    const newToken = readStoredToken();
    if (newToken !== token) {
      setToken(newToken);
      if (newToken) {
        // Token found for this backend - check auth status
        if (!IS_PLATFORM && !DISABLE_LOCAL_AUTH) {
          void checkAuthStatus();
        } else {
          setIsLoading(true);
          checkOnboardingStatus().finally(() => setIsLoading(false));
        }
      } else if (token !== null) {
        // No token for this device - clear session to trigger re-authentication
        clearSession();
      }
    }
  }, [checkOnboardingStatus, checkAuthStatus, clearSession, token]);

  // Initial auth setup - only runs on mount (empty deps).
  // Device switches are handled by the prevBackendRef effect above.
  useEffect(() => {
    if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
      setUser({ username: DISABLE_LOCAL_AUTH ? 'local-user' : 'platform-user' });
      setNeedsSetup(false);
      setIsLoading(true);
      checkOnboardingStatus().finally(() => setIsLoading(false));
      return;
    }

    void checkAuthStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const logout = useCallback(() => {
    const tokenToInvalidate = token;
    clearSession();

    if (tokenToInvalidate) {
      void api.auth.logout().catch((caughtError: unknown) => {
        console.error('Logout endpoint error:', caughtError);
      });
    }
  }, [clearSession, token]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding: modelConfiguration.state === 'ready' || modelConfiguration.state === 'empty',
      modelConfiguration,
      gatewayRuntime,
      error,
      login,
      register,
      logout,
      refreshOnboardingStatus,
      retryGateway,
    }),
    [
      error,
      isLoading,
      login,
      logout,
      needsSetup,
      gatewayRuntime,
      modelConfiguration,
      refreshOnboardingStatus,
      register,
      retryGateway,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

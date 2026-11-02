import { useTranslation } from 'react-i18next';
import PilotVLogo from '../../app-shell/PilotVLogo';

const loadingDotAnimationDelays = ['0s', '0.1s', '0.2s'];

export default function AuthLoadingScreen() {
  const { t } = useTranslation('common');
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="text-center">
        <div className="mb-6 flex justify-center text-foreground">
          <PilotVLogo height={44} animated={false} />
        </div>

        <div className="flex items-center justify-center space-x-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-blue-500"
              style={{ animationDelay: delay }}
            />
          ))}
        </div>

        <p className="mt-2 text-muted-foreground">{t('common:uiText.loading')}</p>
      </div>
    </div>
  );
}

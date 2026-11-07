// 登录页上的设备切换器。
//
// 切到需要登录的设备（NAS、洛杉矶 mac 这些开了账号的机器）时，应用会停在登录页。
// 这里原本没有设备下拉：登不上这台设备，就没法切回能用的那台——用户只会觉得
// 「切换不成功」，其实只是被困在登录页上了。所以登录页也必须能换设备。

import DeviceSwitcher from '../../app-shell/DeviceSwitcher';
import { getPilotVRuntime } from '../../app-shell/pilotvRuntime';

export default function AuthDevicePicker() {
  const runtime = getPilotVRuntime();
  const currentName = runtime?.device?.name || runtime?.defaultName || '当前设备';
  const currentOrigin = runtime?.backend || '';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          当前设备
        </span>
        <span className="truncate text-sm font-semibold text-foreground" title={currentOrigin}>
          {currentName}
        </span>
      </div>
      <DeviceSwitcher compact />
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        这台设备需要登录才能使用。登录不上也没关系，先切到别的设备继续。
      </p>
    </div>
  );
}

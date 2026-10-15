import { bootAppearance } from './lib/appearanceRuntime';
import { installDeviceRouting } from './components/app-shell/pilotvRuntime';

// 设备路由必须赶在 main.jsx 之前装好：那之前发出的请求分不出是哪个标签页在连哪台设备。
// 两个 script 都是 module，按书写顺序执行，所以这里正好是最早能装的位置。
installDeviceRouting();

bootAppearance();

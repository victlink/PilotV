import { useEffect } from 'react';
import { keepDeviceInUrl } from './pilotvRuntime';

/**
 * 什么都不渲染，只负责在挂载后把 ?d= 钉在地址栏上。
 *
 * 必须挂在路由内部：前端路由自己会包一层 history.pushState，
 * 只有等它接好之后再包一层，?d= 才不会被内部跳转抹掉。
 */
export default function DeviceUrlSync() {
  useEffect(() => { keepDeviceInUrl(); }, []);
  return null;
}
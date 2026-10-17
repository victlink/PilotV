// 评审面板住在 MainContent 里面，页面标签条住在 MainAreaV2 外面，两棵子树互不相通。
// 切到别的页面时这里递一个事件过去，让面板跟着收起来 —— 和侧栏打开「改动」用的
// pilotdeck:open-changes 是同一套做法。
export const REVIEW_CLOSE_EVENT = 'pilotdeck:close-review';

export type PilotDeckTuiTheme = {
  brand: string;
  brandAccent: string;
  background: string;
  panel: string;
  text: string;
  subtle: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  permission: string;
};

export const pilotDeckDarkBlueTheme: PilotDeckTuiTheme = {
  brand: "rgb(238,234,218)",
  // V 必须和 Web / 桌面字标一致用品牌橙（#e55a09），不要用旧的蓝色强调色。
  brandAccent: "rgb(229,90,9)",
  background: "rgb(7,15,28)",
  panel: "rgb(10,25,47)",
  text: "rgb(230,237,247)",
  subtle: "rgb(120,145,170)",
  border: "rgb(45,75,110)",
  success: "rgb(74,222,128)",
  warning: "rgb(250,204,21)",
  error: "rgb(248,113,113)",
  permission: "rgb(96,165,250)",
};

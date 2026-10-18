const IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif',
];

const PDF_EXTENSIONS = ['pdf'];

const OFFICE_EXTENSIONS = [
  'doc', 'docx', 'wps', 'xls', 'xlsx', 'et', 'ppt', 'pptx', 'dps', 'odt', 'ods', 'odp',
];

const SPREADSHEET_EXTENSIONS = ['xls', 'xlsx', 'et', 'ods'];
const WORD_EXTENSIONS = ['doc', 'docx', 'wps', 'odt'];
const PRESENTATION_EXTENSIONS = ['ppt', 'pptx', 'dps', 'odp'];

const VIDEO_EXTENSIONS = [
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v', 'ogv', '3gp',
];

const AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'weba', 'wma',
];

const BINARY_EXTENSIONS = [
  // Images
  ...IMAGE_EXTENSIONS,
  // Archives
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz',
  // Executables
  'exe', 'dll', 'so', 'dylib', 'app', 'dmg', 'msi',
  // Media
  ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS,
  // Documents
  ...PDF_EXTENSIONS, ...OFFICE_EXTENSIONS,
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Database
  'db', 'sqlite', 'sqlite3',
  // Other binary
  'bin', 'dat', 'iso', 'img', 'class', 'jar', 'war', 'pyc', 'pyo'
];

const getExtension = (filename: string): string =>
  filename.split('.').pop()?.toLowerCase() ?? '';

export const isBinaryFile = (filename: string): boolean =>
  BINARY_EXTENSIONS.includes(getExtension(filename));

export const isImageFile = (filename: string): boolean =>
  IMAGE_EXTENSIONS.includes(getExtension(filename));

/**
 * 视频 / 音频要在编辑器里能直接播，所以从「二进制、显示不了」那一堆里分出来。
 * 和图片不同：视频不能整文件读成 blob（几十 MB 起，内存吃不消还得等下完才播），
 * 必须让 <video>/<audio> 直接吃 Range URL 边下边播。
 */
export const isVideoFile = (filename: string): boolean =>
  VIDEO_EXTENSIONS.includes(getExtension(filename));

export const isAudioFile = (filename: string): boolean =>
  AUDIO_EXTENSIONS.includes(getExtension(filename));

export const isMediaFile = (filename: string): boolean =>
  isVideoFile(filename) || isAudioFile(filename);

export const isPdfFile = (filename: string): boolean =>
  PDF_EXTENSIONS.includes(getExtension(filename));

export const isOfficeFile = (filename: string): boolean =>
  OFFICE_EXTENSIONS.includes(getExtension(filename));

export const isSpreadsheetFile = (filename: string): boolean =>
  SPREADSHEET_EXTENSIONS.includes(getExtension(filename));

export const isWordFile = (filename: string): boolean =>
  WORD_EXTENSIONS.includes(getExtension(filename));

export const isPresentationFile = (filename: string): boolean =>
  PRESENTATION_EXTENSIONS.includes(getExtension(filename));

export const isBuiltinOfficeFile = (filename: string): boolean =>
  ['docx', 'xlsx', 'pptx'].includes(getExtension(filename));

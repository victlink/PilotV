import type { CSSProperties } from 'react';
import './PilotVLogo.css';

/* 字形轮廓为品牌定稿，不得改动；只有出现位置与动画在变。
 * 本文件由 scripts/build_brand_component.py 从批准版动效派生，
 * 不要手工编辑动画结构。 */

type Letter = {
  ch: string;
  x: number;
  d: string;
};

const LETTERS: readonly Letter[] = [
  { ch: 'P', x: 8.00, d: 'M655 742Q787 742 845.0 805.0Q903 868 903 981Q903 1031 888.0 1072.0Q873 1113 842.5 1142.5Q812 1172 765.5 1188.0Q719 1204 655 1204H479V742ZM655 1457Q809 1457 919.5 1420.5Q1030 1384 1101.5 1320.0Q1173 1256 1207.0 1169.0Q1241 1082 1241 981Q1241 872 1206.0 781.0Q1171 690 1099.0 625.0Q1027 560 916.5 523.5Q806 487 655 487H479V0H141V1457Z' },
  { ch: 'i', x: 67.60, d: 'M422 1037V0H112V1037ZM454 1321Q454 1284 439.0 1251.5Q424 1219 398.0 1194.5Q372 1170 337.5 1155.5Q303 1141 264 1141Q226 1141 193.0 1155.5Q160 1170 134.5 1194.5Q109 1219 94.5 1251.5Q80 1284 80 1321Q80 1359 94.5 1392.0Q109 1425 134.5 1450.0Q160 1475 193.0 1489.0Q226 1503 264 1503Q303 1503 337.5 1489.0Q372 1475 398.0 1450.0Q424 1425 439.0 1392.0Q454 1359 454 1321Z' },
  { ch: 'l', x: 90.30, d: 'M415 1497V0H105V1497Z' },
  { ch: 'o', x: 112.30, d: 'M583 1053Q701 1053 798.0 1016.0Q895 979 964.5 910.0Q1034 841 1072.5 742.5Q1111 644 1111 521Q1111 397 1072.5 297.5Q1034 198 964.5 128.5Q895 59 798.0 21.5Q701 -16 583 -16Q464 -16 366.5 21.5Q269 59 198.5 128.5Q128 198 89.5 297.5Q51 397 51 521Q51 644 89.5 742.5Q128 841 198.5 910.0Q269 979 366.5 1016.0Q464 1053 583 1053ZM583 214Q690 214 740.5 289.5Q791 365 791 519Q791 673 740.5 748.0Q690 823 583 823Q473 823 422.0 748.0Q371 673 371 519Q371 365 422.0 289.5Q473 214 583 214Z' },
  { ch: 't', x: 166.40, d: 'M476 -16Q402 -16 345.5 5.5Q289 27 250.5 66.5Q212 106 192.0 162.0Q172 218 172 287V823H84Q60 823 43.0 838.5Q26 854 26 884V1005L191 1037L252 1290Q264 1338 320 1338H482V1035H739V823H482V308Q482 272 499.5 248.5Q517 225 550 225Q567 225 578.5 228.5Q590 232 598.5 236.5Q607 241 614.5 244.5Q622 248 632 248Q646 248 654.5 241.5Q663 235 672 221L766 74Q706 29 631.0 6.5Q556 -16 476 -16Z' },
  { ch: 'V', x: 200.80, d: 'M1448 1457 864 0H558L-26 1457H246Q290 1457 317.0 1436.5Q344 1416 358 1384L640 604Q660 553 679.0 492.5Q698 432 715 366Q729 432 746.5 492.5Q764 553 784 604L1064 1384Q1075 1412 1103.5 1434.5Q1132 1457 1174 1457Z' },
];

/* 蓝线：宽满时是下划线，窄时就是循环起点的那个点。 */
const LINE = { x: 200.7, y: 91.85, w: 71.3, h: 5.5, rx: 2.75 };
/* V 转到正侧面时的细边线。 */
const V_EDGE = { x: 236.35, y1: 8, y2: 80.85, width: 0.8 };

export type PilotVLogoProps = {
  /** 渲染高度（px）。宽度按字标比例自动推导。 */
  height?: number;
  /** false 时显示完整静态字标。 */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
};

const VIEWBOX_W = 275;
const VIEWBOX_H = 98;

export function PilotVLogo({
  height = 20,
  animated = true,
  className,
  style,
  'aria-hidden': ariaHidden,
}: PilotVLogoProps) {
  return (
    <svg
      viewBox="4 3 275 98"
      width={(height * VIEWBOX_W) / VIEWBOX_H}
      height={height}
      preserveAspectRatio="xMinYMid meet"
      {...(ariaHidden ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'PilotV' })}
      className={['pv-logo', animated && 'pv-logo--animated', className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      {/* 字母：循环里先从 V 下方汇聚成字标，再被 V 逐个吞回蓝线 */}
      {LETTERS.filter(l => l.ch !== 'V').map(letter => (
        <g key={letter.ch} className={`pv-logo__letter pv-logo__letter-${letter.ch}`}>
          <g transform={`translate(${letter.x} 80.85) scale(0.050 -0.050)`}>
            <path d={letter.d} />
          </g>
        </g>
      ))}

      {/* V：浮现后绕自身竖直轴持续左右转身 */}
      <g className="pv-logo__v">
        <line
          className="pv-logo__v-edge"
          x1={V_EDGE.x}
          x2={V_EDGE.x}
          y1={V_EDGE.y1}
          y2={V_EDGE.y2}
          strokeWidth={V_EDGE.width}
          strokeLinecap="round"
        />
        <g className="pv-logo__v-spin">
          {LETTERS.filter(l => l.ch === 'V').map(letter => (
            <g key={letter.ch} transform={`translate(${letter.x} 80.85) scale(0.050 -0.050)`}>
              <path d={letter.d} strokeWidth={32} paintOrder="stroke" />
            </g>
          ))}
        </g>
      </g>

      <rect
        className="pv-logo__line"
        x={LINE.x}
        y={LINE.y}
        width={LINE.w}
        height={LINE.h}
        rx={LINE.rx}
      />
    </svg>
  );
}

export default PilotVLogo;

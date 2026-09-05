/**
 * アプリ全体で使う型（設計書 §5-1）
 *
 * **データだけを置く。ロジックを書かない。**
 * 場面の定義は `data/scenes.ts`、動物の定義は `data/animals.ts`。
 */

/* ---- ループと品質 -------------------------------------------------------- */

export type QualityLevel = 0 | 1 | 2 | 3 | 4;

/** 毎フレームの更新に渡す情報 */
export interface FrameContext {
  /** 固定タイムステップ（秒） */
  dt: number;
  /** アプリ起動からの経過秒 */
  elapsed: number;
  /** 通しフレーム番号 */
  frame: number;
}

/* ---- 場面 ---------------------------------------------------------------- */

/**
 * 遊び方（§4-5）
 *
 * `hideout` … 4箇所に4体が住む。ばあの後もその場にいる
 * `chase`   … 1体だけが住み、ばあの後に次の隠れ場所へ移動する。
 *              残り3箇所は空になるが、押したら必ず反応する（不変条件3b / §4-6）
 */
export type SceneMode = 'hideout' | 'chase';

/** 場面（おうち / そと / うみ / のはら） */
export interface SceneConfig {
  id: string;
  /** ひらがな。読み上げと開発用で、画面には文字を出さない（§2） */
  label: string;
  mode: SceneMode;
  /** null なら手続き生成（不変条件7） */
  backgroundUrl: string | null;
  ambientSound: string | null;
  /**
   * 隠れ場所。**必ず4箇所**（§5-3）。
   * 増やすと1つあたりが小さくなり、1歳半の指では押しにくくなる。
   */
  spots: SpotConfig[];
  /** mode 'chase' のときだけ使う。ここに住む1体 */
  runner?: AnimalId;
}

/** 隠れ場所の形。開き方もこれで決まる */
export type SpotKind =
  | 'box' // 箱のふたが開く
  | 'door' // ドアが開く
  | 'curtain' // カーテンが左右に開く
  | 'bush' // 草むらから飛び出す
  | 'rock' // 岩の陰から回り込んで出る
  | 'water' // 水面から顔を出す
  | 'blanket' // 布がめくれる
  | 'hollow' // 木の洞から
  | 'pot'; // 植木鉢から

export interface SpotConfig {
  id: string;
  kind: SpotKind;
  position: [number, number, number];
  scale: number;
  /**
   * 画面上の当たり半径（CSS px）。既定 120。
   * 判定は 3D のレイではなく `ScreenProjector.distancePx()` で行う（§7-3）。
   * **空の隠れ場所も同じ判定を持つ。** 空だからと外すと不変条件3b を破る。
   */
  hitRadiusPx: number;
  /**
   * ここに住む動物。複数入れておくと毎回どれかが出る（§6-2）。
   * mode 'chase' では**空配列**にする（誰が入っているかは実行時に決まる）。
   */
  animals: AnimalId[];
}

/* ---- 動物 ---------------------------------------------------------------- */

export type AnimalId = string;

/** 「ばあ！」の声。AudioBus の VoiceClip に対応する */
export type VoiceId = 'baa';

export interface AnimalConfig {
  id: AnimalId;
  /** null なら手続き生成（不変条件7） */
  modelUrl: string | null;
  /**
   * 頭が -z を向いていないモデルは true。
   * **自動判定は誤るのでやめた**（みずのなかで実測）。
   */
  modelFlip?: boolean;
  /**
   * 体軸まわりの向き[度]。背が上を向かないモデルに指定する。
   * `normalizeModelGeometry` は「いちばん長い軸が体軸」までしか決められない。
   */
  modelRollDeg?: number;
  scale: number;
  /** 手続き生成の体色 */
  color: string;
  bellyColor: string;
  /** null なら共通の声を使う */
  voice: VoiceId | null;
  /** 出かたの癖（§6-2 でときどき変わる） */
  style: AnimalStyle;
  /** 隠れているとき、どこがはみ出すか（§4-2。mode 'chase' では使わない） */
  hintPart: HintPart;
  /**
   * シルエットで見分けるための体型。
   * **未指定だと全部同じ形になる。** みずのなかで、体型を指定しなかったために
   * チョウチョウウオもメダカも同じ魚になった。色より輪郭で決まる。
   */
  bodyHeight?: number;
  bodyWidth?: number;

  /**
   * 体の作り。省略すると 'mammal'。
   * **`bodyPlan` / `headTop` / `snout` / `tail` を必ず指定すること。**
   * 省略すると耳も鼻も尾も無い塊になり、どの動物も同じ輪郭になる（§5-2）。
   */
  bodyPlan?: BodyPlan;
  headTop?: HeadTop;
  snout?: Snout;
  tail?: TailShape;
  coat?: Coat;
}

export type AnimalStyle = 'pop' | 'slide' | 'spin' | 'flip' | 'peek';
export type HintPart = 'tail' | 'ear' | 'nose' | 'foot' | 'fin';

/* ---- 手続き生成の輪郭（§5-2「見分けは色より輪郭」） ---------------------- */

/**
 * 体の作り。**これが輪郭のいちばん大きな違いになる。**
 *
 * 動物ごとに `id` で分岐を書くのはやめた。17体で分岐が3箇所に散り、
 * 「新しい動物を足したのに、尾だけ他所の分岐に入れ忘れる」が起きる。
 * ここに書いたものだけで形が決まるようにしてある。
 */
export type BodyPlan =
  | 'mammal' // 4足のけもの。胴＋頭＋耳＋鼻＋尾
  | 'bird' // とり。丸い胴・くちばし・翼・尾羽
  | 'fish' // さかな。**横向きに作る**（正面から見ても魚に見えないため）
  | 'octopus' // たこ。丸い頭＋足
  | 'crab' // かに。平たい体＋はさみ＋目の柄
  | 'insect' // むし。細い胴＋大きな羽
  | 'frog'; // かえる。平たい体＋頭の上の目

/** 頭の上に付くもの。耳だけでなく角やとさかもここ */
export type HeadTop =
  | 'none'
  | 'triangleEars'
  | 'floppyEars'
  | 'roundEars'
  | 'longEars'
  | 'tuftEars'
  | 'horns'
  | 'comb'
  | 'antennae';

/** 顔の前に出るもの */
export type Snout = 'none' | 'muzzle' | 'point' | 'beak' | 'flat' | 'wide';

/** 後ろに付くもの */
export type TailShape = 'none' | 'thin' | 'bushy' | 'puff' | 'feather' | 'curl';

/** 体の表面。輪郭を大きく変えるものだけ持つ */
export type Coat = 'plain' | 'spiky' | 'fluffy' | 'banded' | 'spotted';

/* ---- 状態 ---------------------------------------------------------------- */

/**
 * 隠れ場所の状態（§4-1）。
 * **どの状態でもタップは受け付ける**（不変条件2）。
 */
export type SpotState = 'hidden' | 'appearing' | 'out' | 'hiding' | 'moving';

# 地図描画高速化 PoC レポート

## 結論

現行相当の SVG 再構築方式から描画基盤を分離する効果は大きい。特に 960 × 540 の操作中は、WebGL 版だけがほぼ一貫して 16.7 ms/frame を下回った。

ただし、最大のボトルネックは常に描画 API そのものではない。10m 詳細データでは、ラベル候補を作るための `bounds` / `area` / `centroid` と投影計算が支配的である。WebGL 化だけでは詳細復帰は約 407 ms のままで、目標の約 50 ms には届かない。

採用方針は次の組み合わせが妥当である。

1. 先に `Interaction -> MapState -> SceneBuilder -> Renderer` と `LabelEngine` を分離する。
2. 地理計算を一度だけ実行し、解像度・投影リビジョン・viewport 単位でキャッシュする。
3. 10m の準備を Worker に移し、110m を表示したまま詳細 scene を非同期に差し替える。
4. 最終的な地物描画と picking は WebGL、文字は SVG/HTML とする。
5. Canvas2D は実装リスクの低い参照実装・fallback として残せるが、極域ドラッグを含む最終性能では WebGL が優位である。

## 計測対象

PoC は本体の `tools/browser/language-distribution-map.js` を変更せず、同じ D3 / topojson 系のデータを使って次の方式を比較した。

- `current-svg`: 現行の高コストな処理形状を再現
  - `bounds` / `area` / `centroid` の重複
  - SVG path 文字列生成
  - DOM の削除・再作成
  - 同期 `getBBox()`
- `retained-svg`: SVG node を保持し、地理計算と文字計測を整理
- `canvas`: `geoPath(projection, context)` による地物描画、RGB picking canvas、SVG labels
- `webgl`: 静的頂点バッファ、GPU 投影・回転、offscreen picking、SVG labels

固定シナリオは以下である。

- 初回全球表示
- 大国選択
- 小国選択
- 極域をまたぐ球面ドラッグ
- 言語分布
- ホイールズーム
- 10m 詳細復帰

目標は、操作中 16.7 ms/frame 未満、50 ms 超の描画処理なし、詳細復帰約 50 ms とした。

## 960 × 540 のウォーム計測

Chrome 151、devicePixelRatio 2。3 回のウォーム実行について、各実行の p50 / p95 / max の中央値を示す。括弧内は 1 実行あたりの 16.7 ms 超過数である。

| シナリオ | 現行相当 SVG | Retained SVG | Canvas2D | WebGL |
|---|---:|---:|---:|---:|
| 初回全球 | 20.7 / 24.4 / 34.9 ms (8/8) | 15.9 / 21.7 / 26.0 ms (3/8) | 13.5 / 16.8 / 17.7 ms (2/8) | **9.5 / 10.4 / 11.6 ms (0/8)** |
| 大国選択 | 18.3 / 20.3 / 20.7 ms (8/8) | 14.8 / 17.2 / 19.1 ms (3/8) | 12.7 / 15.9 / 19.5 ms (1/8) | **11.8 / 15.2 / 15.3 ms (0/8)** |
| 小国選択 | 24.9 / 30.8 / 31.9 ms (8/8) | 21.5 / 27.7 / 28.4 ms (8/8) | 16.2 / 17.0 / 18.5 ms (2/8) | **12.7 / 14.4 / 14.8 ms (0/8)** |
| 言語分布 | 19.3 / 21.9 / 24.2 ms (8/8) | 12.9 / 14.1 / 15.1 ms (0/8) | 12.7 / 12.9 / 14.2 ms (0/8) | **9.8 / 11.0 / 16.1 ms (0/8)** |
| ホイールズーム | 18.6 / 19.6 / 24.8 ms (24/24) | 13.4 / 17.3 / 18.2 ms (4/24) | 14.6 / 17.6 / 18.9 ms (8/24) | **10.3 / 12.8 / 14.8 ms (0/24)** |
| 極域ドラッグ | 17.6 / 26.7 / 37.2 ms (25/36) | 14.7 / 17.6 / 18.6 ms (7/36) | 19.4 / 25.2 / 25.8 ms (28/36) | **10.7 / 14.1 / 17.7 ms (1/36)** |

110m の個別描画処理には 50 ms 超のサンプルはなかった。PoC 全体の Long Task は複数方式を同期連続実行するベンチハーネス自身の影響を含むため、renderer ごとの判定には使用していない。

### 操作中の評価

- 現行相当 SVG は、全シナリオでフレーム予算を継続的に超える。
- Retained SVG は通常操作を大きく改善するが、小国選択と極域操作に余裕がない。
- Canvas2D は全球・大国・言語分布では十分速いが、球面ドラッグでは CPU による path traversal が残る。
- WebGL は球面ドラッグとホイールズームを含め、唯一ほぼ一貫して目標内に収まる。

## 320 × 320 のウォーム計測

小さい viewport でも傾向は同じである。値は p50 / p95 / max。

| シナリオ | 現行相当 SVG | Retained SVG | Canvas2D | WebGL |
|---|---:|---:|---:|---:|
| 初回全球 | 19.5 / 20.4 / 42.5 ms | 12.6 / 15.7 / 20.6 ms | 11.9 / 14.0 / 16.5 ms | **9.1 / 11.7 / 16.8 ms** |
| 大国選択 | 17.9 / 18.4 / 23.0 ms | 12.4 / 13.2 / 14.5 ms | 12.1 / 12.5 / 22.3 ms | **8.7 / 10.7 / 15.0 ms** |
| 小国選択 | 22.0 / 23.0 / 36.0 ms | 15.4 / 15.6 / 19.8 ms | 14.7 / 15.1 / 30.1 ms | **10.8 / 14.1 / 19.6 ms** |
| 言語分布 | 17.4 / 19.2 / 23.9 ms | 12.7 / 13.0 / 16.4 ms | 11.9 / 12.2 / 15.7 ms | **8.6 / 9.4 / 12.7 ms** |
| ホイールズーム | 18.4 / 20.1 / 27.2 ms | 12.5 / 13.3 / 15.8 ms | 11.6 / 12.2 / 14.7 ms | **8.6 / 9.9 / 14.4 ms** |
| 極域ドラッグ | 17.4 / 23.2 / 28.3 ms | 11.7 / 16.5 / 28.7 ms | 14.6 / 18.1 / 28.8 ms | **11.1 / 15.2 / 16.6 ms** |

## 現行相当 SVG の費用内訳

320 × 320 の初回全球表示の代表実行では次のようになった。

| 処理 | 時間 |
|---|---:|
| `bounds` / `area` / `centroid` | 9.0 ms |
| 重複した投影地理計算 | 5.3 ms |
| SVG path 文字列生成 | 4.4 ms |
| DOM 再構築 + `getBBox()` | 3.0 ms |

単独で支配する処理が一つあるのではなく、同じ feature を複数回走査する構造が積み上がっている。

対して同じ初回表示では、Canvas2D の可視 canvas 描画が約 2.7 ms、picking canvas が約 2.7 ms、WebGL の draw 自体は計測限界に近い値だった。WebGL でも label scene の構築には約 8.6 ms を要している。

## 10m 詳細復帰

960 × 540 のウォーム計測。値は代表的な中央値である。

| 方式 | 主な内訳 | 合計 |
|---|---|---:|
| 現行相当 SVG | 地理計算 300.5 + 重複計算 189.4 + path 238.7 + DOM 82.0 ms | **794.2 ms** |
| Retained SVG | scene 296.5 + path 232.0 + DOM 51.3 ms | **567.6 ms** |
| Canvas2D | scene 304.3 + visible 157.7 + picking 160.0 ms | **619.4 ms** |
| WebGL | label scene 374.3 + pick 25.7 + labels 0.7 ms | **407.2 ms** |

WebGL の 10m mesh は初回だけ約 162 ms で構築・upload され、buffer は約 15.5 MB だった。以後の可視 draw は 1 ms 未満である。

### 10m を保持した球面ドラッグ

10m mesh を GPU buffer に保持し、操作中はラベル配置と picking の再構築を止めた 36 frame の極域ドラッグでは、WebGL の main-thread draw submission は p50 0.00 ms、p95 0.10 ms、最大 0.10 msだった。16.7 ms 超・50 ms 超はいずれも 0 frame である。GPU 完了時間そのものではなく CPU 側の投入時間の計測だが、操作追従の主スレッド負荷という点では十分な余裕がある。

したがって、10m を操作中に 110m へ落とすこと自体は必須ではない。10m の geometry は表示したまま動かし、ラベル衝突計算・詳細 picking・anchor 再計算だけを操作終了時または低頻度更新へ分離する構成が有力である。

この結果から、詳細復帰約 50 ms を実現するには以下が必須である。

- 10m 頂点 buffer を起動前または Worker で準備する。
- feature の面積・代表点・ラベル anchor を事前計算または永続キャッシュする。
- selection 変更では geometry を作り直さず palette のみ更新する。
- detail scene 完成まで 110m を維持し、準備完了後に一度だけ差し替える。
- label collision は geometry frame と分離し、操作中は既存配置を保持、settle 後に低頻度で更新する。

Canvas2D は可視 canvas と picking canvas の両方で全 10m path を走査するため、キャッシュなしでは詳細復帰の目標を達成できない。

## 現行コードで確認した重複

本体コードには次の高コスト箇所がある。

- `countryLabelCandidates`: 全 feature に `path.bounds` / `path.area` / `path.centroid`
- `projectedCountryAreas`: `bounds` / `area` を再計算
- `visibleOverviewFeatureIds`: 再び `path.bounds`
- `drawCountryLabels`: label の削除・再作成、各候補で `getBBox()`、衝突判定は候補数に対して二次的
- `drawPlaceLabels`: 同様に削除・再作成、`getBBox()` と衝突判定
- `renderProjectedViewport`: path、border、coastline、marker、graticule、label をまとめて再生成
- 全体描画: `svg.replaceChildren()`
- 球面移動: 120 ms 間隔の preview 再描画と、その後 80 ms の detail 復帰

120 ms の節流は計算量を隠すが、ポインタに地図が追従しない感覚を生む。目標構成では `requestAnimationFrame` ごとに低解像度 geometry を動かし、重い label/detail 更新だけを別スケジュールにする。

## 推奨アーキテクチャ

### Interaction

- pointer、wheel、keyboard、方位ダイヤルを扱う。
- DOM や投影を直接更新せず、pan / rotate / zoom / select の intent を発行する。
- drag 中の anchor 座標を保持し、renderer に依存しない。

### MapState

- projection、rotation、zoom、viewport、選択集合、表示解像度、interaction phase を保持する。
- revision を持つ immutable snapshot とし、古い Worker 結果を破棄できるようにする。
- 国集合・言語集合・viewpoint の意味論はここより上位で決まり、renderer には style/pick ID として渡す。

### SceneBuilder

- MapState と immutable geometry から renderer-neutral な scene を作る。
- visible feature、style palette、pick ID、label anchor を一度だけ算出する。
- cache key は少なくとも `(geometryResolution, projectionRevision, viewport, labelRevision)` とする。
- 10m の decode、triangulation、重い地理計算は Worker へ送る。

### Renderer

- `render(scene, frameState)` と `pick(x, y)` を最小契約とする。
- Retained SVG、Canvas2D、WebGL を交換可能にする。
- WebGL は geometry buffer を保持し、選択変更は palette texture/uniform のみ更新する。
- picking ID は SceneBuilder の feature table に逆引きする。

### LabelEngine

- label candidate、優先順位、collision、表示文字列を担当する。
- `getBBox()` を hot path で使わず、canvas `measureText` と文字列・font 単位の cache を使う。
- 操作中は label DOM を保持し、必要なら低優先度 label のみ隠す。
- settle 後に再配置し、geometry の rAF と分離する。

## 移行順序

### Phase 1: 境界の抽出

本体の見た目と挙動を維持したまま、Interaction / MapState / SceneBuilder / Renderer / LabelEngine の境界を導入する。最初の renderer は retained SVG とし、機能側の開発と描画側の変更を分離する。

### Phase 2: 計算の一元化

- `bounds` / `area` / `centroid` を scene ごとに一回へ統合
- label width cache
- DOM node の保持
- 110m / 10m scene cache
- detail Worker と progressive swap

この段階だけでも通常操作は大きく改善し、WebGL 移行時の比較基準になる。

### Phase 3: WebGL geometry + picking

地物と picking のみ WebGL に置き換える。文字は SVG/HTML のまま維持する。投影・回転・zoom は uniform、selection/style は palette 更新で処理する。

Canvas2D renderer は fallback と、WebGL の投影・picking の正しさを比較する参照実装として有用である。

### Phase 4: detail と label の調整

10m Worker、事前 anchor、label settle を統合し、詳細復帰を約 50 ms に近づける。ここで初めて 120 ms preview timer を rAF ベースへ完全に置き換える。

## 採用判断

- **最終 geometry renderer:** WebGL を推奨。
- **文字:** SVG/HTML を維持。
- **短期の安全な改善:** Retained SVG と計算キャッシュ。
- **Canvas2D:** fallback / 参照実装。通常の 110m 操作には十分だが、960 × 540 の極域ドラッグではフレーム予算を安定して満たさなかった。
- **最優先課題:** renderer の交換より前に、SceneBuilder と LabelEngine の重複計算を解消すること。

WebGL は必要だが、それだけでは十分ではない。効果を最大化する境界は「地理データを毎回 DOM 向け文字列に変換する」構造を止め、immutable geometry と低頻度 label layout を分離することである。

## ラベルパイプラインの個別計測

`label-benchmark.html` では、文字を SVG のまま維持しつつ、次の二方式を実データで比較した。

- 現行相当: 10m の全 feature に `area` / `bounds` / `centroid` を適用し、投影面積も再計算する。都市候補は全 2,613 件を投影し、SVG text を再作成して `getBBox()` と総当たり衝突判定を行う。
- キャッシュ方式: 地理座標上の代表点・面積と文字幅を一度だけ作り、frame 中は投影、viewport culling、uniform grid による衝突判定、keyed SVG node の差分更新だけを行う。

Chrome 151、960 × 540、10m の 258 country feature と 2,613 place を使用した。値は p50 / p95 / max である。

| シナリオ | 現行相当 合計 | キャッシュ方式 合計 |
|---|---:|---:|
| 全球 | 396.3 / 438.0 / 457.6 ms | **0.8 / 1.0 / 1.1 ms** |
| 欧州高密度 | 417.6 / 426.2 / 433.8 ms | **0.3 / 0.4 / 0.8 ms** |
| 東アジア高密度 | 419.9 / 436.3 / 441.5 ms | **0.3 / 0.5 / 0.7 ms** |
| 極域ドラッグ | 659.9 / 799.4 / 901.0 ms | **1.2 / 2.1 / 3.3 ms** |

キャッシュ生成は一度だけ 140.1 ms を要した。Worker または初期ロード中へ移せる費用であり、pan / rotate / zoom の各 frame に課す必要はない。

### 費用の所在

全球の現行相当 p50 は、country の地理指標生成 235.5 ms、重複した投影面積計算 136.6 ms、`getBBox()` を含む DOM と衝突判定 19.6 msだった。極域ではそれぞれ 382.1 ms、245.7 ms、29.3 msへ増え、`getBBox()` 部分も最大 150.5 msに達した。

したがって、最大の問題は文字描画自体ではない。10m geometry から label candidate を frame ごとに再導出することが支配的であり、その後に synchronous layout read と二次的な衝突判定が重なっている。

### 採用方針

- ラベルを WebGL texture や SDF text へ移す必要はない。SVG/HTML のままなら多言語 font fallback、RTL、アクセシビリティ、選択・tooltip を保ちやすい。
- `FeatureIndex` に地理座標上の代表点、静的面積、優先度を保持する。projection 変更時にも geometry 全体から再計算しない。
- `PlaceIndex` はデータロード時に構築し、現在 viewport に入り得る候補だけを投影する。候補数が増える場合は緯度経度 grid または spatial index を使う。
- 文字幅は `(font, locale, text)` 単位で cache し、hot path の `getBBox()` を除く。font load 完了時だけ該当 cache を無効化する。
- collision は uniform grid または R-tree で近傍だけを調べ、候補全体との総当たりを止める。
- SVG node は key で保持し、`transform`、`opacity`、必要な text だけを更新する。毎 frame の削除・再作成を止める。
- drag / wheel 中は採用済みラベル集合を保持して座標だけ追従させる。操作終了後およそ 40–50 msで完全な候補選択と衝突解決を一度実行する。
- 国・言語・locale・データ変更のような意味的変更時だけ候補集合を再構築し、単なる pan / rotate / zoom とは revision を分ける。

境界は `LabelEngine.update(mapState, featureIndex, placeIndex) -> LabelScene` とし、geometry renderer と独立させる。候補抽出や高密度時の配置は Worker へ移せるが、今回のキャッシュ方式は main thread 上でも p95 2.1 ms以下だったため、最初から Worker を必須にはしない。

この個別ベンチは本体の全 frame を計測したものではなく、高コストなラベル処理形状を隔離した上限比較である。ただし、既存コードで確認した重複処理と同じ API を実データへ適用しており、ラベル設計を renderer から分離すべきという判断には十分な差が出ている。

## PoC の制約

- `current-svg` は本体コードの高コストな処理形状を隔離再現したもので、本体への直接 instrumentation ではない。
- WebGL 投影・clipping は PoC 用の近似であり、D3 の全投影と完全一致する製品実装ではない。
- WebGL PoC は塗り triangle を主対象とし、国境線の最終品質は検証対象外である。
- 都市・国名 label の完全な製品ルールではなく、renderer 間の同一負荷比較を目的にしている。
- cold load、ネットワーク、module cache は renderer の評価から分離した。

本 PoC は本体コードを変更しておらず、最終移行も実施していない。

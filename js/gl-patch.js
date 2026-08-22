/* =========================================================
 * gl-patch.js — StageGL に加算合成("lighter")を教える差し替えパッチ
 *
 * なぜ必要か:
 *   同梱の CreateJS 1.0.0 の StageGL(WebGL 描画)は、compositeOperation を
 *   一切見ない。gl.blendFuncSeparate を初期化時に1回設定するだけなので、
 *   このゲームが発光表現(レールの光・パーティクル・妖弾・月光など約120箇所)
 *   に使っている "lighter"(加算合成)が全部ただの半透明になってしまう。
 *
 * どう直すか:
 *   StageGL はシーングラフを歩きながら「カード」(テクスチャ付き四角形)を
 *   バッチに積み、まとめて1回の draw で描く(_appendToBatchGroup → _drawBuffers)。
 *   ブレンドは GL のグローバル状態なので、「合成モードが替わるカードを積む前に、
 *   溜まっているぶんを今のモードで描き切ってからブレンドを切り替える」だけで
 *   加算合成が実現できる。このファイルは _appendToBatchGroup を同梱ビルドの
 *   実装(min.js から復元)+α で差し替える。追加点は★印の3箇所だけ:
 *     ★1 親コンテナの compositeOperation を子へ継承する(railFlow はレイヤー
 *         Container 側に lighter が付いているため、継承しないと効かない)
 *     ★2 実効モードが現在の GL ブレンド状態と違ったら flush して切り替える
 *     ★3 フレームの頭で必ず通常合成に戻す(前フレームの状態を持ち越さない)
 *   Stage 5(携帯の GPU 送出量の根治)で 2 箇所追加:
 *     ★4 _drawBuffers の転送を使った分だけに(1 flush 1.44MB → 数 KB)
 *     ★5 alpha<=0 の表示物を積まない(Canvas 2D と同じ可視判定)
 *
 * 安全装置:
 *   ・CreateJS の min ビルドはメソッド/プロパティ名を短縮しない(ローカル変数
 *     のみ)ので、prototype の差し替えが成立する。それでも将来ビルドを差し
 *     替えたときのため、想定した内部メソッドが無ければ「何もしない」で抜ける
 *     (その場合 lighter が無視されるだけで、描画自体は壊れない)。
 *   ・Canvas 2D の Stage(フォールバック時)はこのファイルに一切触られない。
 *
 * ブレンド値の根拠:
 *   main.js は StageGL を premultiply=false で作る(シェーダも非乗算)。
 *   非乗算アルファの加算合成は blendFunc(SRC_ALPHA, ONE)。
 *   通常合成は初期化時と同じ blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA,
 *   ONE, ONE_MINUS_SRC_ALPHA) に戻す。
 * ========================================================= */
(function () {
  "use strict";
  if (!window.createjs || !createjs.StageGL) return;
  var StageGL = createjs.StageGL;
  var proto = StageGL.prototype;
  // 想定外のビルドなら何もしない(上の「安全装置」参照)
  if (typeof proto._appendToBatchGroup !== "function" ||
      typeof proto._drawBuffers !== "function" ||
      typeof proto._batchDraw !== "function" ||
      typeof proto._loadTextureImage !== "function" ||
      typeof proto._insertTextureInBatch !== "function" ||
      !StageGL.UV_RECT || !StageGL.INDICIES_PER_CARD) return;

  // GL のブレンド状態を切り替え、いまどちらかをステージに控える
  function applyBlend(stage, gl, lighter) {
    if (lighter) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    } else {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
                           gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    stage._ppLighter = lighter;
  }

  // ★3 フレームの頭で必ず通常合成から始める。
  // ついでに flush 回数を数える(_ppFlushLast は ?fps=1 の計測表示が読む)
  var origBatchDraw = proto._batchDraw;
  proto._batchDraw = function (sceneGraph, gl, ignoreCache) {
    if (this._ppLighter) applyBlend(this, gl, false);
    this._ppFlushCount = 0;
    origBatchDraw.call(this, sceneGraph, gl, ignoreCache);
    this._ppFlushLast = this._ppFlushCount;
  };

  // ★4 flush(_drawBuffers)の GPU 転送を「積んだカードの分だけ」にする。
  //
  // なぜ必要か:
  //   同梱ビルドの _drawBuffers は batchCardCount に関係なく、頂点/UV/テクスチャ
  //   番号/alpha の 4 配列を丸ごと bufferSubData する。配列はバッチ上限
  //   (DEFAULT_MAX_BATCH_SIZE=1万カード)で確保されているので、1 回の flush で
  //   480KB+480KB+240KB+240KB = 約 1.44MB を CPU→GPU へ送る。純正は 1 フレーム
  //   1 flush だから目立たないが、★2 の加算合成は lighter⇔通常 の境界ごとに
  //   flush するため、背景の光層・レールの光・粒子・危機の帳で 1 フレームに
  //   15〜100 回=20〜140MB/フレーム の転送になっていた(携帯の描画が崩れる主因)。
  //
  // どう直すか:
  //   subarray(0, 使った長さ) のビュー(コピーなし)を渡す。100 カードなら
  //   約 7KB。描画結果は完全に同一(drawArrays も使った分しか読まない)。
  //   それ以外は min.js の実装をそのまま復元している。
  var _CARD_I = StageGL.INDICIES_PER_CARD;     // 6 頂点/カード
  proto._drawBuffers = function (gl) {
    var n = this.batchCardCount;
    if (n <= 0) return;
    this._ppFlushCount = (this._ppFlushCount || 0) + 1;
    if (this.vocalDebug) {
      console.log("Draw[" + this._drawID + ":" + this._batchID + "] : " + this.batchReason);
    }
    var shader = this._activeShader;
    var vBuf = this._vertexPositionBuffer, iBuf = this._textureIndexBuffer;
    var uBuf = this._uvPositionBuffer, aBuf = this._alphaBuffer;
    var nI = n * _CARD_I, nV = nI * 2;
    gl.useProgram(shader);
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuf);
    gl.vertexAttribPointer(shader.vertexPositionAttribute, vBuf.itemSize, gl.FLOAT, false, 0, 0);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._vertices.subarray(0, nV));
    gl.bindBuffer(gl.ARRAY_BUFFER, iBuf);
    gl.vertexAttribPointer(shader.textureIndexAttribute, iBuf.itemSize, gl.FLOAT, false, 0, 0);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._indices.subarray(0, nI));
    gl.bindBuffer(gl.ARRAY_BUFFER, uBuf);
    gl.vertexAttribPointer(shader.uvPositionAttribute, uBuf.itemSize, gl.FLOAT, false, 0, 0);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._uvs.subarray(0, nV));
    gl.bindBuffer(gl.ARRAY_BUFFER, aBuf);
    gl.vertexAttribPointer(shader.alphaAttribute, aBuf.itemSize, gl.FLOAT, false, 0, 0);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._alphas.subarray(0, nI));
    gl.uniformMatrix4fv(shader.pMatrixUniform, gl.FALSE, this._projectionMatrix);
    for (var h = 0; h < this._batchTextureCount; h++) {
      var tex = this._batchTextures[h];
      gl.activeTexture(gl.TEXTURE0 + h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.setTextureParams(gl, tex.isPOT);
    }
    gl.drawArrays(gl.TRIANGLES, 0, nI);
    this._batchID++;
  };

  // 同梱ビルドの _appendToBatchGroup の忠実な復元 + ★1/★2。
  // 第6引数 parentOp(親から継承した合成モード)だけがオリジナルへの追加で、
  // StageGL 本体からの最初の呼び出し(5引数)では undefined = 通常合成になる
  proto._appendToBatchGroup = function (container, gl, concatMtx, concatAlpha, ignoreCache, parentOp) {
    if (!container._glMtx) container._glMtx = new createjs.Matrix2D();
    var cMtx = container._glMtx;
    cMtx.copy(concatMtx);
    if (container.transformMatrix) {
      cMtx.appendMatrix(container.transformMatrix);
    } else {
      cMtx.appendTransform(container.x, container.y, container.scaleX, container.scaleY,
                           container.rotation, container.skewX, container.skewY,
                           container.regX, container.regY);
    }

    var subL, subT, subR, subB;
    var count = container.children.length;
    for (var i = 0; i < count; i++) {
      var item = container.children[i];
      // ★5 alpha<=0 の子は積まない。Canvas 2D の isVisible() は alpha>0 を見るが
      //    純正 StageGL は親の累積 alpha しか見ず、透明な全画面 Shape(危機の帳・
      //    ゲームオーバーの暗幕・稲光など、休眠中は alpha=0 で置いてある物)を
      //    毎フレーム画面 7 枚分ほど無駄に合成していた。本リポジトリの
      //    「減衰 alpha は 0 にクランプして描画スキップ」規約が GL でも効くようになる
      if (!(item.visible && concatAlpha) || !(item.alpha > 0)) continue;

      // ★1 実効の合成モード: 自分に指定が無ければ親のものを継承する
      var op = item.compositeOperation || parentOp;

      var useCache = item.cacheCanvas && !ignoreCache;
      if (!useCache) {
        if (item._updateState) item._updateState();
        if (item.children) {
          // cache されていない Container は中へ潜る(op を伝搬)
          this._appendToBatchGroup(item, gl, cMtx, item.alpha * concatAlpha, undefined, op);
          continue;
        }
      }

      // ---- ここから「カード」1枚としてバッチへ積む ----
      // ★2 合成モードが替わる → 溜まっているカードを今のモードで描き切り、
      //    ブレンドを切り替えてから続きを積む(バッチが割れるのは
      //    lighter⇔通常 の境界だけ。玉やHUDは通常合成なので割れない)
      var lighter = op === "lighter";
      if (lighter !== !!this._ppLighter) {
        this.batchReason = "blendChange";
        this._drawBuffers(gl);
        this.batchCardCount = 0;
        applyBlend(this, gl, lighter);
      }
      if (this.batchCardCount + 1 > this._maxCardsPerBatch) {
        this.batchReason = "vertexOverflow";
        this._drawBuffers(gl);
        this.batchCardCount = 0;
      }

      if (!item._glMtx) item._glMtx = new createjs.Matrix2D();
      var iMtx = item._glMtx;
      iMtx.copy(cMtx);
      if (item.transformMatrix) {
        iMtx.appendMatrix(item.transformMatrix);
      } else {
        iMtx.appendTransform(item.x, item.y, item.scaleX, item.scaleY,
                             item.rotation, item.skewX, item.skewY, item.regX, item.regY);
      }

      var uvRect, texIndex, image, frame, texture, src;
      if (item._webGLRenderStyle === 2 || useCache) {
        image = (ignoreCache ? false : item.cacheCanvas) || item.image;
      } else if (item._webGLRenderStyle === 1) {
        frame = item.spriteSheet.getFrame(item.currentFrame);
        if (frame === null) continue;
        image = frame.image;
      } else {
        continue;   // 非cacheの Shape/Text は GL では描けない(cache が必須)
      }

      var uvs = this._uvs, vertices = this._vertices;
      var indices = this._indices, alphas = this._alphas;
      if (!image) continue;

      if (image._storeID === undefined) {
        texture = this._loadTextureImage(gl, image);
        this._insertTextureInBatch(gl, texture);
      } else {
        texture = this._textureDictionary[image._storeID];
        if (!texture) {
          if (this.vocalDebug) console.log("Texture should not be looked up while not being stored.");
          continue;
        }
        if (texture._batchID !== this._batchID) this._insertTextureInBatch(gl, texture);
      }
      texIndex = texture._activeIndex;

      if (item._webGLRenderStyle === 2 || useCache) {
        if (!useCache && item.sourceRect) {
          // Bitmap の切り出し表示(照準線の破線などが使う)
          if (!item._uvRect) item._uvRect = {};
          src = item.sourceRect;
          uvRect = item._uvRect;
          uvRect.t = src.y / image.height;
          uvRect.l = src.x / image.width;
          uvRect.b = (src.y + src.height) / image.height;
          uvRect.r = (src.x + src.width) / image.width;
          subL = 0; subT = 0;
          subR = src.width + subL; subB = src.height + subT;
        } else {
          uvRect = StageGL.UV_RECT;
          if (useCache) {
            src = item.bitmapCache;
            subL = src.x + (src._filterOffX / src.scale);
            subT = src.y + (src._filterOffY / src.scale);
            subR = (src._drawWidth / src.scale) + subL;
            subB = (src._drawHeight / src.scale) + subT;
          } else {
            subL = 0; subT = 0;
            subR = image.width + subL; subB = image.height + subT;
          }
        }
      } else if (item._webGLRenderStyle === 1) {
        var rect = frame.rect;
        uvRect = frame.uvRect;
        if (!uvRect) uvRect = StageGL.buildUVRects(item.spriteSheet, item.currentFrame, false);
        subL = -frame.regX; subT = -frame.regY;
        subR = rect.width - frame.regX; subB = rect.height - frame.regY;
      }

      var offI = this.batchCardCount * StageGL.INDICIES_PER_CARD;
      var offV = offI * 2;
      vertices[offV]      = subL * iMtx.a + subT * iMtx.c + iMtx.tx;
      vertices[offV + 1]  = subL * iMtx.b + subT * iMtx.d + iMtx.ty;
      vertices[offV + 2]  = subL * iMtx.a + subB * iMtx.c + iMtx.tx;
      vertices[offV + 3]  = subL * iMtx.b + subB * iMtx.d + iMtx.ty;
      vertices[offV + 4]  = subR * iMtx.a + subT * iMtx.c + iMtx.tx;
      vertices[offV + 5]  = subR * iMtx.b + subT * iMtx.d + iMtx.ty;
      vertices[offV + 6]  = vertices[offV + 2];
      vertices[offV + 7]  = vertices[offV + 3];
      vertices[offV + 8]  = vertices[offV + 4];
      vertices[offV + 9]  = vertices[offV + 5];
      vertices[offV + 10] = subR * iMtx.a + subB * iMtx.c + iMtx.tx;
      vertices[offV + 11] = subR * iMtx.b + subB * iMtx.d + iMtx.ty;
      uvs[offV]      = uvRect.l; uvs[offV + 1]  = uvRect.t;
      uvs[offV + 2]  = uvRect.l; uvs[offV + 3]  = uvRect.b;
      uvs[offV + 4]  = uvRect.r; uvs[offV + 5]  = uvRect.t;
      uvs[offV + 6]  = uvRect.l; uvs[offV + 7]  = uvRect.b;
      uvs[offV + 8]  = uvRect.r; uvs[offV + 9]  = uvRect.t;
      uvs[offV + 10] = uvRect.r; uvs[offV + 11] = uvRect.b;
      indices[offI] = indices[offI + 1] = indices[offI + 2] =
        indices[offI + 3] = indices[offI + 4] = indices[offI + 5] = texIndex;
      alphas[offI] = alphas[offI + 1] = alphas[offI + 2] =
        alphas[offI + 3] = alphas[offI + 4] = alphas[offI + 5] = item.alpha * concatAlpha;
      this.batchCardCount++;
    }
  };
})();

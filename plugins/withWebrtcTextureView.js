/**
 * Expo config plugin + postinstall patch: render Android RTCViews on a
 * TextureView instead of a SurfaceView.
 *
 * WHY: react-native-webrtc's Android RTCView draws through SurfaceViewRenderer.
 * A SurfaceView's video lives in its own window layer, so it ignores
 * borderRadius / overflow:hidden (the small call tiles were square while iOS
 * clipped them round), it lags a few px behind a dragged parent, and remounting
 * one for a track that another view just released could leave it black.
 * A TextureView is an ordinary view: it clips, moves and remounts like
 * everything else. The renderer below drives WebRTC's EglRenderer into the
 * TextureView's SurfaceTexture and exposes the same methods WebRTCView already
 * calls, so WebRTCView only changes its field type.
 *
 * WHY PATCH node_modules: the module compiles straight out of node_modules.
 * Idempotent. `npm install` restores the pristine files — package.json
 * postinstall re-runs `node plugins/withWebrtcTextureView.js`.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG_DIR = path.join('node_modules', 'react-native-webrtc', 'android', 'src', 'main', 'java', 'com', 'oney', 'WebRTCModule');
const PATCH_MARKER = 'patched by plugins/withWebrtcTextureView.js';

const RENDERER_SOURCE = `package com.oney.WebRTCModule;

// ${PATCH_MARKER} — see that file for why.

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.view.TextureView;

import org.webrtc.EglBase;
import org.webrtc.EglRenderer;
import org.webrtc.GlRectDrawer;
import org.webrtc.RendererCommon;
import org.webrtc.ThreadUtils;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;

import java.util.concurrent.CountDownLatch;

/**
 * SurfaceViewRenderer's API on a TextureView: clips to rounded corners, follows
 * transforms, and composes with other views normally.
 */
public class TextureViewRenderer extends TextureView implements VideoSink, TextureView.SurfaceTextureListener {
    private final EglRenderer eglRenderer;
    private final Object layoutLock = new Object();
    private RendererCommon.RendererEvents rendererEvents;
    private boolean isFirstFrameRendered;
    private int rotatedFrameWidth;
    private int rotatedFrameHeight;
    private int frameRotation;

    public TextureViewRenderer(Context context) {
        super(context);
        eglRenderer = new EglRenderer("TextureViewRenderer@" + Integer.toHexString(System.identityHashCode(this)));
        setSurfaceTextureListener(this);
        setOpaque(false);
    }

    public void init(EglBase.Context sharedContext, RendererCommon.RendererEvents events) {
        ThreadUtils.checkIsOnMainThread();
        rendererEvents = events;
        synchronized (layoutLock) {
            isFirstFrameRendered = false;
            rotatedFrameWidth = 0;
            rotatedFrameHeight = 0;
            frameRotation = 0;
        }
        eglRenderer.init(sharedContext, EglBase.CONFIG_PLAIN, new GlRectDrawer());
        SurfaceTexture st = getSurfaceTexture();
        if (st != null) eglRenderer.createEglSurface(st);
    }

    public void release() {
        eglRenderer.release();
    }

    public void setMirror(boolean mirror) {
        eglRenderer.setMirror(mirror);
    }

    // WebRTCView sizes this view to the frame's aspect itself (cover/contain).
    public void setScalingType(RendererCommon.ScalingType scalingType) {}

    // A TextureView has no separate window layer to order.
    public void setZOrderMediaOverlay(boolean isMediaOverlay) {}

    public void setZOrderOnTop(boolean onTop) {}

    // TextureView throws on a background drawable (API 24+); WebRTCView's
    // "black until the first frame" placeholder is the parent's background.
    @Override
    public void setBackgroundColor(int color) {}

    public void clearImage() {
        eglRenderer.clearImage();
    }

    @Override
    public void onFrame(VideoFrame frame) {
        updateFrameDimensionsAndReportEvents(frame);
        eglRenderer.onFrame(frame);
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
        eglRenderer.createEglSurface(surface);
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {}

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
        final CountDownLatch latch = new CountDownLatch(1);
        eglRenderer.releaseEglSurface(latch::countDown);
        ThreadUtils.awaitUninterruptibly(latch);
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture surface) {}

    private void updateFrameDimensionsAndReportEvents(VideoFrame frame) {
        synchronized (layoutLock) {
            if (!isFirstFrameRendered) {
                isFirstFrameRendered = true;
                if (rendererEvents != null) rendererEvents.onFirstFrameRendered();
            }
            if (rotatedFrameWidth != frame.getRotatedWidth()
                    || rotatedFrameHeight != frame.getRotatedHeight()
                    || frameRotation != frame.getRotation()) {
                if (rendererEvents != null) {
                    rendererEvents.onFrameResolutionChanged(
                            frame.getBuffer().getWidth(), frame.getBuffer().getHeight(), frame.getRotation());
                }
                rotatedFrameWidth = frame.getRotatedWidth();
                rotatedFrameHeight = frame.getRotatedHeight();
                frameRotation = frame.getRotation();
            }
        }
    }
}
`;

function patchWebrtcTextureView(projectRoot = process.cwd()) {
  const dir = path.join(projectRoot, PKG_DIR);
  const viewFile = path.join(dir, 'WebRTCView.java');
  if (!fs.existsSync(viewFile)) {
    console.warn('[withWebrtcTextureView] WebRTCView.java not found — skipped');
    return false;
  }
  fs.writeFileSync(path.join(dir, 'TextureViewRenderer.java'), RENDERER_SOURCE);

  let src = fs.readFileSync(viewFile, 'utf8');
  if (src.includes(PATCH_MARKER)) return true;
  const field = 'private final SurfaceViewRenderer surfaceViewRenderer;';
  const ctor = 'surfaceViewRenderer = new SurfaceViewRenderer(context);';
  if (!src.includes(field) || !src.includes(ctor)) {
    console.warn('[withWebrtcTextureView] anchors not found in WebRTCView.java — not patched');
    return false;
  }
  src = src
    .replace(field, `// ${PATCH_MARKER}: TextureView instead of SurfaceView.\n    private final TextureViewRenderer surfaceViewRenderer;`)
    .replace(ctor, 'surfaceViewRenderer = new TextureViewRenderer(context);');
  fs.writeFileSync(viewFile, src);
  console.log('[withWebrtcTextureView] patched WebRTCView.java (TextureViewRenderer)');
  return true;
}

const withWebrtcTextureView = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      patchWebrtcTextureView(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);

module.exports = withWebrtcTextureView;
module.exports.patchWebrtcTextureView = patchWebrtcTextureView;

if (require.main === module) {
  patchWebrtcTextureView(path.resolve(__dirname, '..'));
}

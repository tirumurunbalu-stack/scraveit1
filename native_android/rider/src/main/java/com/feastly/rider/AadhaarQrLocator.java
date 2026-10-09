package com.feastly.rider;

import java.util.ArrayList;
import java.util.List;

/**
 * Finds the Aadhaar Secure QR on a full e-Aadhaar page or a photo of the
 * letter, so a rider can upload the whole sheet from the gallery.
 *
 * On a full-page screenshot the QR is only ~160px wide for ~177 modules, which
 * no decoder reads in place. The QR is the only large, square, evenly dense
 * patch of black/white transitions on the page (text comes in lines with gaps),
 * so we find it, crop it, and enlarge it with Lanczos resampling before
 * decoding. Pure Java so it can be tested off the device.
 */
final class AadhaarQrLocator {
    private static final int CELL = 8;
    private static final int EDGE = 60;
    private static final double DENSE = 0.18;

    private AadhaarQrLocator() {}

    /** Candidate QR boxes {x0, y0, x1, y1} in image coordinates, largest first. */
    static List<int[]> findQrBoxes(int[] gray, int width, int height) {
        List<int[]> boxes = new ArrayList<>();
        // A photo has 3-6px modules, a screenshot ~1px: look at a few working sizes.
        int longSide = Math.max(width, height);
        int[] targets = {longSide, 2400, 1600, 1000};
        for (int target : targets) {
            if (target > longSide) continue;
            double factor = (double) target / longSide;
            int w = Math.max(1, (int) Math.round(width * factor));
            int h = Math.max(1, (int) Math.round(height * factor));
            int[] g = factor == 1 ? gray : resizeArea(gray, width, height, w, h);
            for (int[] box : boxesAt(g, w, h)) {
                int[] mapped = {(int) (box[0] / factor), (int) (box[1] / factor), (int) Math.ceil(box[2] / factor), (int) Math.ceil(box[3] / factor)};
                if (!overlapsAny(boxes, mapped)) boxes.add(mapped);
            }
        }
        boxes.sort((a, b) -> Integer.compare((b[2] - b[0]) * (b[3] - b[1]), (a[2] - a[0]) * (a[3] - a[1])));
        return boxes;
    }

    private static boolean overlapsAny(List<int[]> boxes, int[] box) {
        for (int[] other : boxes) {
            int ix = Math.min(other[2], box[2]) - Math.max(other[0], box[0]);
            int iy = Math.min(other[3], box[3]) - Math.max(other[1], box[1]);
            if (ix > 0 && iy > 0) {
                long inter = (long) ix * iy;
                long area = Math.min((long) (other[2] - other[0]) * (other[3] - other[1]), (long) (box[2] - box[0]) * (box[3] - box[1]));
                if (inter * 2 > area) return true;
            }
        }
        return false;
    }

    private static List<int[]> boxesAt(int[] g, int w, int h) {
        int cw = (w - 1) / CELL, ch = (h - 1) / CELL;
        List<int[]> out = new ArrayList<>();
        if (cw < 6 || ch < 6) return out;
        boolean[] dense = new boolean[cw * ch];
        for (int cy = 0; cy < ch; cy++) {
            for (int cx = 0; cx < cw; cx++) {
                int hx = 0, vy = 0;
                for (int y = cy * CELL; y < cy * CELL + CELL; y++) {
                    int row = y * w;
                    for (int x = cx * CELL; x < cx * CELL + CELL; x++) {
                        int p = g[row + x];
                        if (Math.abs(g[row + x + 1] - p) > EDGE) hx++;
                        if (Math.abs(g[row + w + x] - p) > EDGE) vy++;
                    }
                }
                double n = CELL * CELL;
                dense[cy * cw + cx] = Math.min(hx, vy) / n >= DENSE;
            }
        }
        boolean[] seen = new boolean[cw * ch];
        int[] stack = new int[cw * ch];
        for (int start = 0; start < dense.length; start++) {
            if (!dense[start] || seen[start]) continue;
            int top = 0, count = 0;
            int x0 = cw, y0 = ch, x1 = 0, y1 = 0;
            stack[top++] = start;
            seen[start] = true;
            while (top > 0) {
                int i = stack[--top];
                int x = i % cw, y = i / cw;
                count++;
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
                int[] next = {x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, y > 0 ? i - cw : -1, y < ch - 1 ? i + cw : -1};
                for (int j : next) {
                    if (j >= 0 && dense[j] && !seen[j]) { seen[j] = true; stack[top++] = j; }
                }
            }
            if (count < 36) continue;
            // Trim sparse edge rows and columns (a caption line touching the QR).
            boolean changed = true;
            while (changed) {
                changed = false;
                if (y1 - y0 > 2 && fill(dense, cw, x0, y0, x1, y0 + 1) < 0.5) { y0++; changed = true; }
                if (y1 - y0 > 2 && fill(dense, cw, x0, y1 - 1, x1, y1) < 0.5) { y1--; changed = true; }
                if (x1 - x0 > 2 && fill(dense, cw, x0, y0, x0 + 1, y1) < 0.5) { x0++; changed = true; }
                if (x1 - x0 > 2 && fill(dense, cw, x1 - 1, y0, x1, y1) < 0.5) { x1--; changed = true; }
            }
            int bw = x1 - x0, bh = y1 - y0;
            if (Math.min(bw, bh) < 6) continue;
            double aspect = (double) bw / bh;
            if (aspect < 0.75 || aspect > 1.33) continue;
            if (fill(dense, cw, x0, y0, x1, y1) < 0.8) continue;
            out.add(new int[]{x0 * CELL, y0 * CELL, x1 * CELL, y1 * CELL});
        }
        return out;
    }

    private static double fill(boolean[] dense, int cw, int x0, int y0, int x1, int y1) {
        int on = 0, all = 0;
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) { all++; if (dense[y * cw + x]) on++; }
        return all == 0 ? 0 : (double) on / all;
    }

    /** Box-filter downscale, used only for finding boxes. */
    private static int[] resizeArea(int[] g, int w, int h, int nw, int nh) {
        int[] out = new int[nw * nh];
        for (int y = 0; y < nh; y++) {
            int sy0 = y * h / nh, sy1 = Math.max(sy0 + 1, (y + 1) * h / nh);
            for (int x = 0; x < nw; x++) {
                int sx0 = x * w / nw, sx1 = Math.max(sx0 + 1, (x + 1) * w / nw);
                long sum = 0;
                for (int sy = sy0; sy < sy1; sy++) for (int sx = sx0; sx < sx1; sx++) sum += g[sy * w + sx];
                out[y * nw + x] = (int) (sum / ((long) (sy1 - sy0) * (sx1 - sx0)));
            }
        }
        return out;
    }

    /** Scales to try for a box, aiming at ~7px per module for a ~177-module QR. */
    static int[] scalesFor(int side) {
        int[] targets = {1200, 1350, 1050, 1500, 900};
        List<Integer> scales = new ArrayList<>();
        for (int target : targets) {
            int s = Math.max(1, Math.min(10, Math.round((float) target / side)));
            if (!scales.contains(s)) scales.add(s);
        }
        int[] out = new int[scales.size()];
        for (int i = 0; i < out.length; i++) out[i] = scales.get(i);
        return out;
    }

    /** The box plus a quiet-zone margin, clamped to the image: {x0, y0, x1, y1}. */
    static int[] padded(int[] box, int width, int height) {
        int side = Math.max(box[2] - box[0], box[3] - box[1]);
        int pad = Math.max(6, side / 12);
        return new int[]{Math.max(0, box[0] - pad), Math.max(0, box[1] - pad), Math.min(width, box[2] + pad), Math.min(height, box[3] + pad)};
    }

    /** Lanczos-3 enlargement of a region of a grayscale image. Returns {width, height, pixels...} packed as pixels with size in out[0..1]. */
    static int[] enlarge(int[] gray, int width, int[] region, int scale, int[] outSize) {
        int sw = region[2] - region[0], sh = region[3] - region[1];
        int dw = sw * scale, dh = sh * scale;
        outSize[0] = dw; outSize[1] = dh;
        // Horizontal pass.
        float[] tmp = new float[dw * sh];
        float[][] wx = new float[dw][]; int[] fx = new int[dw];
        for (int x = 0; x < dw; x++) { fx[x] = weights(x, scale, sw, wx, x); }
        for (int y = 0; y < sh; y++) {
            int row = (region[1] + y) * width + region[0];
            for (int x = 0; x < dw; x++) {
                float sum = 0; float[] w = wx[x];
                for (int k = 0; k < w.length; k++) {
                    int sx = Math.max(0, Math.min(sw - 1, fx[x] + k));
                    sum += w[k] * gray[row + sx];
                }
                tmp[y * dw + x] = sum;
            }
        }
        // Vertical pass.
        int[] out = new int[dw * dh];
        float[][] wy = new float[dh][]; int[] fy = new int[dh];
        for (int y = 0; y < dh; y++) { fy[y] = weights(y, scale, sh, wy, y); }
        for (int y = 0; y < dh; y++) {
            float[] w = wy[y];
            for (int x = 0; x < dw; x++) {
                float sum = 0;
                for (int k = 0; k < w.length; k++) {
                    int sy = Math.max(0, Math.min(sh - 1, fy[y] + k));
                    sum += w[k] * tmp[sy * dw + x];
                }
                out[y * dw + x] = Math.max(0, Math.min(255, Math.round(sum)));
            }
        }
        return out;
    }

    private static int weights(int dst, int scale, int srcLen, float[][] table, int index) {
        double center = (dst + 0.5) / scale - 0.5;
        int first = (int) Math.floor(center) - 2;
        float[] w = new float[6];
        float total = 0;
        for (int k = 0; k < 6; k++) {
            double t = center - (first + k);
            w[k] = (float) lanczos3(t);
            total += w[k];
        }
        for (int k = 0; k < 6; k++) w[k] /= total;
        table[index] = w;
        return first;
    }

    private static double lanczos3(double t) {
        t = Math.abs(t);
        if (t < 1e-9) return 1;
        if (t >= 3) return 0;
        double pt = Math.PI * t;
        return 3 * Math.sin(pt) * Math.sin(pt / 3) / (pt * pt);
    }
}

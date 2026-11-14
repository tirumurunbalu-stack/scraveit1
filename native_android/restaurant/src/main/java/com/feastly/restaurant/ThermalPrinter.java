package com.feastly.restaurant;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Prints straight to a paired Bluetooth receipt printer with ESC/POS, the command
 * set nearly every small thermal printer sold in India understands, so it works
 * whatever the brand. English text goes as printer text (fast and sharp); a line
 * with Telugu or other letters the printer has no font for is drawn as a picture.
 */
final class ThermalPrinter {
  /** Serial Port Profile: how phones talk to Bluetooth receipt printers. */
  private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
  private final ExecutorService worker = Executors.newSingleThreadExecutor();

  interface Done { void finished(boolean ok, String message); }

  /** One printed line. Built by the page; see printLines() in premium.js. */
  static final class Line {
    String kind = "text";      // text, row, rule, feed, cut
    String text = "";          // text, or the left side of a row
    String right = "";         // row: the right side (amount)
    int align;                 // 0 left, 1 centre, 2 right
    boolean bold;
    boolean big;               // double width and height
    int count = 1;             // feed: blank lines
  }

  /** Paired devices, printers first. Needs BLUETOOTH_CONNECT on Android 12+. */
  @SuppressLint("MissingPermission")
  static List<String[]> pairedDevices() {
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    List<String[]> printers = new ArrayList<>(), others = new ArrayList<>();
    if (adapter == null) return printers;
    Set<BluetoothDevice> bonded = adapter.getBondedDevices();
    if (bonded == null) return printers;
    for (BluetoothDevice device : bonded) {
      String name = device.getName() == null ? device.getAddress() : device.getName();
      BluetoothClass type = device.getBluetoothClass();
      boolean printer = (type != null && type.getMajorDeviceClass() == BluetoothClass.Device.Major.IMAGING)
          || name.toLowerCase(java.util.Locale.ROOT).matches(".*(print|pos|mpt|rpp|mtp|thermal|receipt|xp-|gp-).*");
      (printer ? printers : others).add(new String[]{name, device.getAddress(), printer ? "1" : "0"});
    }
    printers.addAll(others);
    return printers;
  }

  static boolean bluetoothReady() {
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    return adapter != null && adapter.isEnabled();
  }

  static boolean hasBluetooth() { return BluetoothAdapter.getDefaultAdapter() != null; }

  /** Sends one job on the worker thread; jobs never overlap, so two orders print one after the other. */
  void print(String address, int paperMm, List<Line> lines, Done done) {
    worker.execute(() -> {
      byte[] bytes;
      try { bytes = encode(lines, paperMm); }
      catch (Exception error) { done.finished(false, "Could not prepare the slip."); return; }
      String result = send(address, bytes);
      done.finished(result == null, result == null ? "" : result);
    });
  }

  @SuppressLint("MissingPermission")
  private static String send(String address, byte[] bytes) {
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    if (adapter == null) return "This phone has no Bluetooth.";
    if (!adapter.isEnabled()) return "Bluetooth is off. Turn it on and try again.";
    BluetoothDevice device;
    try { device = adapter.getRemoteDevice(address); }
    catch (IllegalArgumentException error) { return "Pick the printer again in Printer settings."; }
    BluetoothSocket socket = null;
    for (int attempt = 0; attempt < 3 && socket == null; attempt++) {
      BluetoothSocket candidate = null;
      try {
        candidate = attempt == 1 ? device.createInsecureRfcommSocketToServiceRecord(SPP)
            : device.createRfcommSocketToServiceRecord(SPP);
        candidate.connect();
        socket = candidate;
      } catch (IOException | SecurityException error) {
        closeQuietly(candidate);
        if (error instanceof SecurityException) return "Allow Nearby devices for Scraveit, then try again.";
        try { Thread.sleep(400); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
      }
    }
    if (socket == null) return "Printer not reachable. Check it is on, has paper and is near the phone.";
    try {
      OutputStream out = socket.getOutputStream();
      // Small pieces with short pauses: cheap printers have small buffers and
      // drop data that arrives faster than they print.
      for (int at = 0; at < bytes.length; at += 512) {
        out.write(bytes, at, Math.min(512, bytes.length - at));
        out.flush();
        Thread.sleep(25);
      }
      // Closing at once can cut the end of the slip on some printers.
      Thread.sleep(Math.min(2500, 400 + bytes.length / 40));
      return null;
    } catch (IOException error) {
      return "The printer stopped while printing. Check the paper and try again.";
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      return "Printing was interrupted.";
    } finally {
      closeQuietly(socket);
    }
  }

  private static void closeQuietly(BluetoothSocket socket) {
    if (socket == null) return;
    try { socket.close(); } catch (IOException ignored) { }
  }

  // ---------------- ESC/POS ----------------

  static int columns(int paperMm) { return paperMm >= 80 ? 48 : 32; }
  static int dots(int paperMm) { return paperMm >= 80 ? 576 : 384; }

  static byte[] encode(List<Line> lines, int paperMm) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    int cols = columns(paperMm);
    write(out, 0x1B, 0x40);           // reset
    write(out, 0x1B, 0x74, 0x00);     // character table PC437 (plain English)
    for (Line line : lines) {
      switch (line.kind) {
        case "rule":
          textLine(out, repeat('-', cols), 0, false, false);
          break;
        case "feed":
          write(out, 0x1B, 0x64, Math.max(1, Math.min(10, line.count)));
          break;
        case "cut":
          write(out, 0x1B, 0x64, 4);                 // paper past the cutter
          write(out, 0x1D, 0x56, 0x42, 0x00);        // partial cut; printers without a cutter ignore it
          break;
        case "row": {
          String left = plain(line.text), right = plain(line.right);
          if (!isAscii(left) || !isAscii(right)) { picture(out, line, paperMm); break; }
          int width = line.big ? cols / 2 : cols;
          for (String row : rowLines(left, right, width)) textLine(out, row, 0, line.bold, line.big);
          break;
        }
        default: {
          String text = plain(line.text);
          if (!isAscii(text)) { picture(out, line, paperMm); break; }
          int width = line.big ? cols / 2 : cols;
          for (String part : wrap(text, width)) textLine(out, part, line.align, line.bold, line.big);
        }
      }
    }
    return out.toByteArray();
  }

  private static void textLine(ByteArrayOutputStream out, String text, int align, boolean bold, boolean big) {
    write(out, 0x1B, 0x61, Math.max(0, Math.min(2, align)));
    write(out, 0x1B, 0x45, bold ? 1 : 0);
    write(out, 0x1D, 0x21, big ? 0x11 : 0x00);
    byte[] body = text.getBytes(StandardCharsets.US_ASCII);
    out.write(body, 0, body.length);
    write(out, 0x0A);
    write(out, 0x1B, 0x45, 0);
    write(out, 0x1D, 0x21, 0x00);
    write(out, 0x1B, 0x61, 0);
  }

  /** Left text wrapped, the amount on the first line at the right edge. */
  static List<String> rowLines(String left, String right, int width) {
    List<String> rows = new ArrayList<>();
    if (right.isEmpty()) { rows.addAll(wrap(left, width)); return rows; }
    if (right.length() > width / 2) {
      rows.addAll(wrap(left, width));
      rows.add(pad(right, width));
      return rows;
    }
    List<String> parts = wrap(left, width - right.length() - 1);
    String first = parts.isEmpty() ? "" : parts.get(0);
    rows.add(first + repeat(' ', width - first.length() - right.length()) + right);
    for (int i = 1; i < parts.size(); i++) rows.add(parts.get(i));
    return rows;
  }

  static List<String> wrap(String text, int width) {
    List<String> out = new ArrayList<>();
    if (width < 1) width = 1;
    for (String paragraph : text.split("\n", -1)) {
      String rest = paragraph.trim();
      if (rest.isEmpty()) { out.add(""); continue; }
      while (rest.length() > width) {
        int cut = rest.lastIndexOf(' ', width);
        if (cut <= 0) cut = width;
        out.add(rest.substring(0, cut).trim());
        rest = rest.substring(cut).trim();
      }
      out.add(rest);
    }
    return out;
  }

  private static String pad(String text, int width) {
    return text.length() >= width ? text : repeat(' ', width - text.length()) + text;
  }

  private static String repeat(char c, int n) {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < n; i++) b.append(c);
    return b.toString();
  }

  /** Swaps symbols printers can't show for plain ones (₹ → Rs.). Telugu stays and is drawn as a picture. */
  static String plain(String text) {
    if (text == null) return "";
    return text.replace("₹", "Rs.").replace('×', 'x').replace('·', '-').replace('–', '-').replace('—', '-')
        .replace('“', '"').replace('”', '"').replace('‘', '\'').replace('’', '\'').replace(' ', ' ')
        .replace("…", "...").replace('\t', ' ');
  }

  static boolean isAscii(String text) {
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c != '\n' && (c < 0x20 || c > 0x7E)) return false;
    }
    return true;
  }

  /** Draws a line the printer has no letters for and sends it as a raster image (GS v 0). */
  private static void picture(ByteArrayOutputStream out, Line line, int paperMm) {
    int width = dots(paperMm);
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    paint.setTextSize(line.big ? 44 : 24);
    paint.setTypeface(line.bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
    String left = plain(line.text), right = "row".equals(line.kind) ? plain(line.right) : "";
    float rightWidth = right.isEmpty() ? 0 : paint.measureText(right) + 12;
    List<String> parts = new ArrayList<>();
    String rest = left.trim();
    float room = Math.max(40, width - rightWidth);
    while (!rest.isEmpty()) {
      int n = paint.breakText(rest, true, room, null);
      if (n <= 0) n = 1;
      int cut = n < rest.length() ? rest.lastIndexOf(' ', n) : n;
      if (cut <= 0) cut = n;
      parts.add(rest.substring(0, cut).trim());
      rest = rest.substring(cut).trim();
      room = width;
    }
    if (parts.isEmpty()) parts.add("");
    Paint.FontMetrics metrics = paint.getFontMetrics();
    int lineHeight = (int) Math.ceil(metrics.descent - metrics.ascent) + 4;
    int height = lineHeight * parts.size();
    Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(bitmap);
    canvas.drawColor(Color.WHITE);
    for (int i = 0; i < parts.size(); i++) {
      String part = parts.get(i);
      float textWidth = paint.measureText(part);
      float x = line.align == 1 ? (width - textWidth) / 2f : line.align == 2 ? width - textWidth : 0;
      float y = i * lineHeight - metrics.ascent + 2;
      canvas.drawText(part, Math.max(0, x), y, paint);
      if (i == 0 && !right.isEmpty()) canvas.drawText(right, width - paint.measureText(right), y, paint);
    }
    int bytesPerRow = width / 8;
    write(out, 0x1B, 0x61, 0);
    write(out, 0x1D, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF, height & 0xFF, (height >> 8) & 0xFF);
    int[] row = new int[width];
    for (int y = 0; y < height; y++) {
      bitmap.getPixels(row, 0, width, 0, y, width, 1);
      for (int xb = 0; xb < bytesPerRow; xb++) {
        int value = 0;
        for (int bit = 0; bit < 8; bit++) {
          int pixel = row[xb * 8 + bit];
          int luminance = (Color.red(pixel) * 299 + Color.green(pixel) * 587 + Color.blue(pixel) * 114) / 1000;
          if (luminance < 128) value |= 0x80 >> bit;
        }
        out.write(value);
      }
    }
    bitmap.recycle();
  }

  private static void write(ByteArrayOutputStream out, int... values) {
    for (int value : values) out.write(value);
  }
}

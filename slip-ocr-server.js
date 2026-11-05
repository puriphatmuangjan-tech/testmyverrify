// =====================================================================
// 🧾 Slip OCR Server — เซิร์ฟเวอร์อ่านข้อความในรูปสลิป (ฟรี · Tesseract)
// ใช้คู่กับบอตหลัก: บอตส่งรูปสลิปมา -> ตอบข้อความที่อ่านได้ + QR บนสลิปกลับไป
// ตั้งค่าใน Render → Environment:
//   OCR_SECRET = รหัสลับ (ตั้งเอง ยาว ๆ) ต้องตรงกับที่ใส่ในหน้าตั้งค่าตรวจสลิปของบอต
//   (ไม่บังคับ) KEEP_AWAKE=0 ปิดการปลุกตัวเอง · OCR_ENG_PASS=0 ปิดรอบอ่านตัวเลข/อังกฤษ
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { createWorker } = require('tesseract.js');
let jpeg = null, PNG = null, jsQR = null;
try { jpeg = require('jpeg-js'); PNG = require('pngjs').PNG; } catch (e) { console.warn('⚠️ [OCR] ไม่มี jpeg-js/pngjs -> ไม่ขยายรูปก่อนอ่าน'); }
try { jsQR = require('jsqr'); } catch (e) { console.warn('⚠️ [OCR] ไม่มี jsqr -> ไม่อ่าน QR บนสลิป'); }

const PORT = process.env.PORT || 3000;
const OCR_SECRET = String(process.env.OCR_SECRET || '');
const LANGS = (process.env.OCR_LANGS || 'tha+eng').split('+').map(s => s.trim()).filter(Boolean);
const ENG_PASS = process.env.OCR_ENG_PASS !== '0';
const MAX_QUEUE = Number(process.env.OCR_MAX_QUEUE) || 20;
const MAX_BYTES = 10 * 1024 * 1024;
// แรมเกินค่านี้ (MB) -> ปิดแล้วเปิดตัวอ่านใหม่ คืนแรม (Render ฟรีมีแรม 512 MB)
const RECYCLE_MB = Number(process.env.OCR_RECYCLE_MB) || 330;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

// ---------- Tesseract (ประหยัดแรม: Render ฟรีมีแรม 512 MB) ----------
// รอบ 1: ไทย+อังกฤษ (ชื่อ / คำว่า จำนวน / วันที่) — เปิดค้างไว้ อ่านได้ทันที
// รอบ 2: อังกฤษอย่างเดียว แบบหาข้อความกระจาย (เลขบัญชี xxx-x-x1234-x / เลขที่รายการ อ่านแม่นกว่า)
//        ใช้เฉพาะเมื่อรอบ 1 อ่านเลขบัญชีไม่ครบ · ปิดตัวอ่านรอบ 1 ก่อน แล้วค่อยเปิดรอบ 2 (ไม่ให้กินแรมพร้อมกัน)
const workerOpts = () => {
  const o = { cachePath: process.env.TESS_CACHE || path.join(os.tmpdir(), 'tess-cache') };
  if (process.env.TESS_LANG_PATH) o.langPath = process.env.TESS_LANG_PATH;
  return o;
};
let mainP = null;
let readyAt = 0;
function getMain() {
  if (!mainP) {
    const t0 = Date.now();
    mainP = (async () => {
      const w = await createWorker(LANGS, 1, workerOpts());
      // ⚡ tessedit_do_invert=0: ไม่ต้องลองอ่านแบบกลับสีทุกบรรทัด (สลิปเป็นตัวหนังสือเข้มบนพื้นสว่าง) -> เร็วขึ้น
      await w.setParameters({ preserve_interword_spaces: '1', tessedit_do_invert: process.env.OCR_INVERT === '1' ? '1' : '0' });
      if (!readyAt) console.log('✅ [OCR] พร้อมใช้งาน (' + LANGS.join('+') + (ENG_PASS ? ' + รอบตัวเลข' : '') + ') ใน ' + (Date.now() - t0) + ' ms');
      readyAt = Date.now();
      return w;
    })().catch(e => { mainP = null; console.error('❌ [OCR] โหลด Tesseract ไม่สำเร็จ:', e.message || e); throw e; });
  }
  return mainP;
}
async function closeMain() {
  const p = mainP;
  mainP = null;
  if (p) { try { await (await p).terminate(); } catch (e) {} }
}
// ⚡ ตัวอ่านรอบ 2 เปิดค้างไว้ใช้ซ้ำ (เดิมเปิด-ปิดทุกครั้ง เสีย CPU โหลดภาษาใหม่ทุกรอบ) · แรมเกินกำหนดค่อยปิดคืนแรม
let engP = null;
function getEng() {
  if (!engP) {
    engP = (async () => {
      const w = await createWorker(['eng'], 1, workerOpts());
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      return w;
    })().catch(e => { engP = null; throw e; });
  }
  return engP;
}
async function closeEng() {
  const p = engP;
  engP = null;
  if (p) { try { await (await p).terminate(); } catch (e) {} }
}
// ⏱️ กันตัวอ่านค้าง: อ่านรูปเดียวนานเกินกำหนด -> ปิดตัวอ่านแล้วเปิดใหม่ (ไม่ให้คิวทั้งหมดค้างตาม)
const RECOG_TIMEOUT = Number(process.env.OCR_JOB_TIMEOUT_MS) || 100000;
async function recognizeSafe(w, img, which) {
  let timer;
  try {
    return await Promise.race([w.recognize(img), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('OCR_STUCK')), RECOG_TIMEOUT); })]);
  } catch (e) {
    if (e && e.message === 'OCR_STUCK') {
      console.error('⏱️ [OCR] ตัวอ่าน' + (which === 'eng' ? 'รอบ 2' : '') + 'ค้างเกิน ' + Math.round(RECOG_TIMEOUT / 1000) + ' วิ -> เปิดใหม่');
      if (which === 'eng') await closeEng(); else await closeMain();
    }
    throw e;
  } finally { clearTimeout(timer); }
}
async function engPass(img) {
  const w = await getEng();
  return String((await recognizeSafe(w, img, 'eng')).data.text || '');
}
// รอบ 1 อ่านเลขบัญชีที่ปิดบางหลักได้ครบ 2 เลข (ผู้โอน + ผู้รับ) แล้ว -> ไม่ต้องอ่านรอบ 2
// คำที่พบในสลิปโอนเงิน (ครอบคลุมคำที่บอทใช้ตัดสินว่า "ดูเหมือนสลิป" ทั้งหมด)
// ไม่มีคำเหล่านี้เลย + ไม่มีตัวเลขแบบยอดเงิน = ไม่ใช่สลิป (รูปพระ / รูปสินค้า / ที่อยู่ / แชท)
const SLIP_WORDS = /โอน|สำเร็จ|สําเร็จ|จำนวน|จํานวน|ยอดเงิน|บาท|THB|ธนาคาร|ธ\.|รายการ|อ้างอิง|ธรรมเนียม|ผู้รับ|ไปยัง|ไปที่|ชำระ|ชําระ|พร้อมเพย์|เป๋าตัง|กสิกร|ไทยพาณิชย์|กรุงไทย|กรุงเทพ|กรุงศรี|ทีทีบี|ทหารไทย|ออมสิน|อาคารสงเคราะห์|ยูโอบี|ซีไอเอ็มบี|เกียรตินาคิน|แลนด์|ทิสโก้|Bank|Transfer|Success|Amount|Ref|PromptPay|K\s*PLUS|K\+|SCB|Krungthai|Krungsri|ttb|GSB|BAAC|UOB|TISCO|CIMB|KKP|kbank|MyMo|Wallet|Paotang/i;
const MONEY_LIKE = /\d[\d,]*\s?[.,]\s?\d{2}(?!\d)|\d\s*(um|vm|ym|uw|wm|un|wn)(?![a-z])/i;
function looksLikeSlipText(t) {
  const x = String(t || '').replace(/ํา/g, 'ำ');
  return SLIP_WORDS.test(x) || MONEY_LIKE.test(x);
}
function needEngPass(text) {
  // ข้อความไม่มีคำที่พบในสลิปเลย -> ไม่ต้องอ่านรอบ 2 (ประหยัด ~5-7 วิ บน Render ฟรี)
  if (!SLIP_WORDS.test(String(text || '').replace(/ํา/g, 'ำ'))) return false;
  const acc = (String(text || '').match(/(?<![A-Za-z0-9])[xX*%\d](?:[xX*%\d\- ]{5,20})[xX*%\d](?![A-Za-z0-9])/g) || [])
    .filter(x => (x.match(/\d/g) || []).length >= 3 && /[xX*%]/.test(x) && x.replace(/[^0-9xX*%]/g, '').length >= 9);
  // บัญชีผู้รับแบบสั้นหลังคำว่า ไปยัง (SCB: "x-0129") ถือว่าอ่านได้แล้ว
  const shortTo = /(ไปยัง|ไปที่)[\s\S]{0,120}?(?<![A-Za-z0-9])[xX*%]{1,8}-?\d{4}(?!\d)/.test(String(text || ''));
  if (new Set(acc.map(a => a.replace(/[^0-9]/g, ''))).size < 2 && !shortTo) return true;
  // ไม่เจอยอดเงิน (x.xx ที่มากกว่า 0 · ค่าธรรมเนียม 0.00 ไม่นับ) -> อ่านรอบ 2 ช่วยหายอด
  // ไม่นับบรรทัดวันเวลา (เช่น "4 พ.ย. 69, 07:20 น.") · ยอดเงินต้องมีจุดทศนิยม (x.xx)
  const money = [];
  for (const l of String(text || '').split('\n')) {
    if (/\d{1,2}:\d{2}/.test(l) && !/บาท|THB|฿/i.test(l)) continue;
    if (/ค่าธรรมเนียม|ธรรมเนียม/.test(l)) continue;
    for (const x of l.match(/\d[\d,]*\s?\.\s?\d\d(?!\d)/g) || []) money.push(parseFloat(x.replace(/[\s,]/g, '')));
  }
  return !money.some(v => v > 0);
}
async function recycleIfHeavy() {
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  if (rss < RECYCLE_MB) return;
  await closeEng();
  await closeMain();
  console.log('♻️ [OCR] แรม ' + rss + ' MB เกิน ' + RECYCLE_MB + ' MB -> เปิดตัวอ่านใหม่');
}

// ---------- คิว: อ่านทีละรูป (กันแรมเต็ม) ----------
let chain = Promise.resolve();
let pending = 0;
function runQueued(fn) {
  pending++;
  const p = chain.then(fn, fn).finally(() => { pending--; });
  chain = p.catch(() => {});
  return p;
}

function keyOk(req) {
  if (!OCR_SECRET) return false;
  const got = Buffer.from(String(req.get('x-ocr-key') || ''));
  const want = Buffer.from(OCR_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function imageType(buf) {
  if (buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  return '';
}

function decodeRGBA(buf, type) {
  if (!jpeg || !PNG) return null;
  try {
    if (type === 'jpeg') return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 300 });
    if (type === 'png') return PNG.sync.read(buf);
  } catch (e) { console.error('⚠️ [OCR] แปลงรูปไม่สำเร็จ:', e.message); }
  return null;
}

// 🔍 เตรียมรูปก่อนอ่าน: ขาวดำ + ขยายรูปเล็ก (สลิปที่ส่งผ่าน Messenger มักถูกย่อ ตัวหนังสือเล็ก อ่านพลาดง่าย)
const OCR_TARGET_WIDTH = Number(process.env.OCR_TARGET_WIDTH) || 1000;
const QUICK_WIDTH = Number(process.env.OCR_QUICK_WIDTH) || 480;     // ความกว้างรูปตอนเช็กเร็วว่าเป็นสลิปไหม
const QUICK_CHECK = process.env.OCR_QUICK_CHECK !== '0';            // ปิดได้ด้วย OCR_QUICK_CHECK=0
function prepareImage(src, fallbackBuf, targetWidth) {
  if (!src) return fallbackBuf;
  try {
    const w = src.width, h = src.height, d = src.data;
    // ⚡ ความกว้างเป้าหมาย: รูปเล็กขยายขึ้น · รูปใหญ่ย่อลง (Render ฟรีมี CPU น้อย ยิ่งพิกเซลมากยิ่งช้า)
    const TARGET = targetWidth || OCR_TARGET_WIDTH;
    const scale = Math.min(3, TARGET / w);
    const W = Math.round(w * scale), H = Math.round(h * scale);
    if (W * H > 6e6) return fallbackBuf;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    // ⚡ เขียนเป็น PNG ขาวดำ 1 ช่องสี + บีบอัดเบา ๆ (เร็วกว่า RGBA บีบอัดเต็มหลายเท่า)
    const outBuf = Buffer.alloc(W * H);
    if (scale < 0.75) {
      // ย่อมาก: เฉลี่ยพิกเซลเป็นบล็อก (คมกว่าเลือกจุด)
      const inv = 1 / scale;
      for (let y = 0; y < H; y++) {
        const sy0 = Math.floor(y * inv), sy1 = Math.min(h, Math.floor((y + 1) * inv));
        for (let x = 0; x < W; x++) {
          const sx0 = Math.floor(x * inv), sx1 = Math.min(w, Math.floor((x + 1) * inv));
          let sum = 0, n = 0;
          for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { sum += g[yy * w + xx]; n++; }
          outBuf[y * W + x] = n ? sum / n : 255;
        }
      }
    } else {
      for (let y = 0; y < H; y++) {
        const fy = Math.min(h - 1, (y + 0.5) / scale - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), ty = Math.max(0, fy - y0);
        for (let x = 0; x < W; x++) {
          const fx = Math.min(w - 1, (x + 0.5) / scale - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), tx = Math.max(0, fx - x0);
          outBuf[y * W + x] = (g[y0 * w + x0] * (1 - tx) + g[y0 * w + x1] * tx) * (1 - ty) + (g[y1 * w + x0] * (1 - tx) + g[y1 * w + x1] * tx) * ty;
        }
      }
    }
    return PNG.sync.write({ width: W, height: H, data: outBuf }, { colorType: 0, inputColorType: 0, inputHasAlpha: false, bitDepth: 8, deflateLevel: 1 });
  } catch (e) { console.error('⚠️ [OCR] เตรียมรูปไม่สำเร็จ ใช้รูปเดิม:', e.message); return fallbackBuf; }
}

// ---------- 📷 QR บนสลิป (เลขที่รายการแม่น 100% · ไม่มียอดเงิน) ----------
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function parseTlv(str) {
  const out = {};
  let i = 0;
  while (i + 4 <= str.length) {
    const id = str.slice(i, i + 2), len = parseInt(str.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(id) || !(len >= 0) || i + 4 + len > str.length) return null;
    out[id] = str.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return i === str.length ? out : null;
}
function parseSlipQr(text) {
  const t = String(text || '').trim();
  if (!/^00\d{2}/.test(t) || t.length < 20 || t.length > 200) return null;
  const top = parseTlv(t);
  const sub = top && top['00'] ? parseTlv(top['00']) : null;
  if (!sub || !sub['02'] || !/^[A-Za-z0-9][A-Za-z0-9\-]{7,44}$/.test(sub['02'].trim())) return null; // UOB มีขีด เช่น 2611036428481645-TFR
  return { bank: /^\d{3}$/.test(sub['01'] || '') ? sub['01'] : '', transRef: sub['02'].trim(), crcOk: top['91'] ? crc16(t.slice(0, -4)) === String(top['91']).toUpperCase() : null };
}
function scaleCrop(img, x0, y0, w, h, s) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  w = Math.min(img.width - x0, Math.floor(w)); h = Math.min(img.height - y0, Math.floor(h));
  if (w < 20 || h < 20) return null;
  const W = Math.round(w * s), H = Math.round(h * s);
  if (W * H > 4e6) return null;
  const o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = y0 + Math.min(h - 1, Math.floor(y / s));
    for (let x = 0; x < W; x++) {
      const sx = x0 + Math.min(w - 1, Math.floor(x / s));
      const si = (sy * img.width + sx) * 4, di = (y * W + x) * 4;
      o[di] = img.data[si]; o[di + 1] = img.data[si + 1]; o[di + 2] = img.data[si + 2]; o[di + 3] = 255;
    }
  }
  return { data: o, width: W, height: H };
}
// ขยายแบบเกลี่ยสี (bilinear) -> QR ในรูปเล็ก/ถูกย่อ (ลูกค้าส่งต่อ / แคปหน้าจอ) อ่านได้ ขยายแบบจุดต่อจุดอ่านไม่ออก
function scaleCropSmooth(img, x0, y0, w, h, s) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  w = Math.min(img.width - x0, Math.floor(w)); h = Math.min(img.height - y0, Math.floor(h));
  if (w < 20 || h < 20) return null;
  const W = Math.round(w * s), H = Math.round(h * s);
  if (W * H > 4e6) return null;
  const src = img.data, iw = img.width;
  const g = (x, y) => { const i = (y * iw + x) * 4; return (src[i] * 77 + src[i + 1] * 150 + src[i + 2] * 29) >> 8; };
  const o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / s - 0.5)), iy = Math.floor(fy), dy = fy - iy;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / s - 0.5)), ix = Math.floor(fx), dx = fx - ix;
      const ax = x0 + ix, ay = y0 + iy;
      const v = g(ax, ay) * (1 - dx) * (1 - dy) + g(ax + 1, ay) * dx * (1 - dy) + g(ax, ay + 1) * (1 - dx) * dy + g(ax + 1, ay + 1) * dx * dy;
      const di = (y * W + x) * 4; o[di] = o[di + 1] = o[di + 2] = v; o[di + 3] = 255;
    }
  }
  return { data: o, width: W, height: H };
}
// phase 1 = จุดที่ QR สลิปอยู่บ่อย (เร็ว เจอเกือบทุกธนาคาร) · phase 2 = ลองละเอียด (ช้า ใช้เมื่อรู้แล้วว่าน่าจะเป็นสลิป)
function findSlipQr(img, phase) {
  if (!jsQR || !img) return null;
  const W = img.width, H = img.height;
  const big = Math.max(W, H);
  const fit = (n) => Math.min(3, Math.max(0.4, n / big));
  // ⚡ เริ่มจากจุดที่ QR สลิปอยู่บ่อย (ขวาล่าง / ขวาบน) ขนาดจริง -> เล็กกว่าทั้งรูป อ่านเร็วกว่ามาก
  const up = (n) => Math.min(3, Math.max(1, n / big)); // รูปเล็กมาก -> ขยาย
  // ⚡ ส่วนที่ตัดมาหา QR: รูปใหญ่ย่อให้ด้านยาวไม่เกิน ~800px (QR สลิปยังใหญ่พอ) · รูปเล็กขยายเหมือนเดิม
  const cs = (w, h) => big < 700 ? up(700) : Math.max(0.5, Math.min(1, 800 / Math.max(w, h)));
  const tries = [
    [W * 0.45, H * 0.4, W * 0.55, H * 0.6, cs(W * 0.55, H * 0.6), 'dontInvert'],   // ขวาล่าง (กสิกร / SCB / ttb / กรุงเทพ / กรุงศรี / ธ.ก.ส.)
    [W * 0.55, 0, W * 0.45, H * 0.4, cs(W * 0.45, H * 0.4), 'dontInvert'],         // ขวาบน (กรุงไทย)
    [0, H * 0.55, W, H * 0.45, cs(W, H * 0.45), 'dontInvert'],                     // แถบล่างทั้งแถบ (UOB อยู่ซ้ายล่าง)
    [W * 0.45, H * 0.4, W * 0.55, H * 0.6, up(700), 'dontInvert'],                 // ขวาล่าง ขนาดเต็ม (เผื่อ QR เล็ก)
    [0, 0, W, H, Math.min(1, fit(1100)), 'dontInvert'],
    [0, 0, W, H, fit(1600), 'attemptBoth'],
    [0, H * 0.4, W, H * 0.6, fit(2000), 'attemptBoth'],
    [0, 0, W, H, fit(2400), 'attemptBoth'],
    [0, H * 0.55, W * 0.5, H * 0.45, up(1000), 'attemptBoth']
  ];
  const list = phase === 1 ? tries.slice(0, 3) : phase === 2 ? tries.slice(3) : tries;
  for (const [x, y, w, h, s, inv] of list) {
    const part = scaleCrop(img, x, y, w, h, s);
    if (!part) continue;
    let code = null;
    try { code = jsQR(part.data, part.width, part.height, { inversionAttempts: inv }); } catch (e) {}
    const p = code && parseSlipQr(code.data);
    if (p) return p;
  }
  // 🔎 รูปเล็ก (QR แค่ไม่กี่สิบพิกเซล เช่น แคปจอ/ส่งต่อ) -> ขยายแบบเกลี่ยสีแล้วลองใหม่ (ทำเฉพาะรูปเล็กที่วิธีปกติหาไม่เจอ)
  // รูปใหญ่ไม่ทำ (QR ใหญ่พออยู่แล้ว) -> รูปที่ไม่ใช่สลิป (รูปพระ/สินค้า) ไม่เสียเวลาเพิ่ม
  if (phase !== 1 && big < 1000) {
    const smooth = [
      [W * 0.45, H * 0.4, W * 0.55, H * 0.6],   // ขวาล่าง
      [W * 0.55, 0, W * 0.45, H * 0.45],        // ขวาบน
      [0, H * 0.5, W, H * 0.5]                  // ครึ่งล่าง
    ];
    for (const [x, y, w, h] of smooth) {
      for (const want of [900]) {
        const s = Math.min(4, Math.max(1.5, want / Math.max(w, h)));
        const part = scaleCropSmooth(img, x, y, w, h, s);
        if (!part) continue;
        let code = null;
        try { code = jsQR(part.data, part.width, part.height, { inversionAttempts: 'dontInvert' }); } catch (e) {}
        const p = code && parseSlipQr(code.data);
        if (p) return p;
      }
    }
  }
  return null;
}

// เช็กว่าเซิร์ฟเวอร์ตื่นอยู่ (ไม่ต้องใช้รหัส)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// สถานะ (ต้องใช้รหัส) — บอตใช้ปุ่ม "ทดสอบการเชื่อมต่อ"
app.get('/status', (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  res.json({ success: true, ready: !!readyAt, langs: LANGS.concat(ENG_PASS ? ['eng-digits'] : []), qr: !!jsQR, queue: pending, memMB: Math.round(process.memoryUsage().rss / 1048576), uptimeSec: Math.round(process.uptime()) });
});

// อ่านข้อความในรูป: body = { image: "<base64>" }
// ตอบ: { text (ไทย+อังกฤษ), textEng (รอบตัวเลข), qr: { bank, transRef } | null }
app.post('/ocr', async (req, res) => {
  if (!keyOk(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  const b64 = String((req.body && req.body.image) || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) return res.status(400).json({ success: false, error: 'NO_IMAGE' });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) return res.status(413).json({ success: false, error: 'FILE_TOO_LARGE' });
  const type = imageType(buf);
  if (!type) return res.status(415).json({ success: false, error: 'IMAGE_FORMAT_UNSUPPORTED' });
  if (pending >= MAX_QUEUE) return res.status(503).json({ success: false, error: 'BUSY' });
  const t0 = Date.now();
  // บอทเลิกรอแล้ว (หมดเวลา/ตัดการเชื่อมต่อ) -> ไม่ต้องอ่านรูปนี้ ไม่ให้คิวยาวโดยเปล่าประโยชน์
  let gone = false;
  res.on('close', () => { if (!res.writableFinished) gone = true; });
  try {
    const out = await runQueued(async () => {
      if (gone) { const err = new Error('CLIENT_GONE'); err.gone = true; throw err; }
      const T = { s: Date.now() };
      let rgba = decodeRGBA(buf, type);
      // ⚡ หา QR จุดที่เจอบ่อยก่อน (เร็ว) · ยังไม่เจอ -> เช็กก่อนว่าเป็นสลิปไหม ค่อยหาละเอียด (ช้า)
      let qr = findSlipQr(rgba, 1);
      // รูปเล็ก (เช่น แคปจอย่อ) หา QR แบบละเอียดได้เร็ว -> ทำเลย
      if (!qr && rgba && Math.max(rgba.width, rgba.height) < 1000) { qr = findSlipQr(rgba, 2); T.qrSmallDone = true; }
      T.qr = Date.now();
      const main = await getMain();
      // ⚡ ไม่พบ QR -> อ่านเร็ว ๆ จากรูปย่อก่อน (ราว 1/3 ของเวลาอ่านเต็ม)
      // ไม่มีคำที่พบในสลิปเลย = ไม่ใช่สลิป (รูปพระ/สินค้า/ที่อยู่) -> หยุดเลย ไม่อ่านเต็ม ไม่ให้คิวช้า
      // สลิปที่มี QR (เกือบทั้งหมด) ไม่ผ่านขั้นนี้ -> เร็วเท่าเดิม
      if (!qr && QUICK_CHECK && rgba) {
        const fullW = Math.round(rgba.width * Math.min(3, OCR_TARGET_WIDTH / rgba.width));
        if (fullW > QUICK_WIDTH * 1.25) {
          const small = prepareImage(rgba, buf, QUICK_WIDTH);
          const rq = await recognizeSafe(main, small, 'main');
          T.quick = Date.now();
          const qt = String(rq.data.text || '');
          if (!looksLikeSlipText(qt)) {
            T.qr2 = 0;
            await recycleIfHeavy();
            return { text: qt.trim() ? qt : '(ไม่พบข้อความในรูป)', textEng: '', qr: null, notSlip: true, confidence: Math.round(Number(rq.data.confidence) || 0),
              timing: 'QR ' + (T.qr - T.s) + ' · เช็กสลิป ' + (T.quick - T.qr) + ' ms · ไม่ใช่สลิป ข้ามการอ่านเต็ม' };
          }
        }
      }
      // น่าจะเป็นสลิป (หรือรูปเล็กที่ไม่ได้เช็กเร็ว) -> หา QR แบบละเอียดต่อ
      if (!qr && !T.qrSmallDone) { const tq = Date.now(); qr = findSlipQr(rgba, 2); T.qr2 = Date.now() - tq; }
      const tPrep0 = Date.now();
      const img = prepareImage(rgba, buf);
      rgba = null;
      T.prep = Date.now();
      const r1 = await recognizeSafe(main, img, 'main');
      T.ocr = Date.now();
      const text = String(r1.data.text || '');
      let textEng = '';
      if (ENG_PASS && needEngPass(text)) {
        try { textEng = await engPass(img); } catch (e) { console.error('⚠️ [OCR] รอบตัวเลขไม่สำเร็จ:', e.message); }
      }
      await recycleIfHeavy();
      T.end = Date.now();
      const timing = 'QR ' + (T.qr - T.s) + (T.quick ? ' · เช็กสลิป ' + (T.quick - T.qr) : '') + (T.qr2 ? ' · QR ละเอียด ' + T.qr2 : '') + ' · เตรียมรูป ' + (T.prep - tPrep0) + ' · อ่าน ' + (T.ocr - T.prep) + (textEng ? ' · รอบ 2 ' + (T.end - T.ocr) : '') + ' ms';
      return { text, textEng, qr, timing, confidence: Math.round(Number(r1.data.confidence) || 0) };
    });
    const ms = Date.now() - t0;
    console.log('🧾 [OCR] อ่านรูป ' + Math.round(buf.length / 1024) + ' KB ใน ' + ms + ' ms (' + (out.notSlip ? 'ไม่ใช่สลิป' : 'ความมั่นใจ ' + out.confidence + '%') + (out.qr ? ' · QR ' + out.qr.transRef : ' · ไม่พบ QR') + ') [' + out.timing + ']');
    res.json({ success: true, ...out, ms });
  } catch (e) {
    if (e && e.gone) { console.log('⏭️ [OCR] ข้ามรูปที่บอทเลิกรอแล้ว (รอคิว ' + Math.round((Date.now() - t0) / 1000) + ' วิ)'); return; }
    console.error('❌ [OCR] อ่านไม่สำเร็จ:', e.message || e);
    res.status(500).json({ success: false, error: 'OCR_FAILED', detail: String(e.message || e).slice(0, 200) });
  }
});

process.on('unhandledRejection', (e) => console.error('⚠️ [Unhandled Rejection]', e && e.message || e));
process.on('uncaughtException', (e) => console.error('⚠️ [Uncaught Exception]', e && e.stack || e));

app.listen(PORT, () => {
  console.log('🧾 Slip OCR Server พร้อมที่พอร์ต ' + PORT + (OCR_SECRET ? '' : ' · ⚠️ ยังไม่ได้ตั้ง OCR_SECRET (จะปฏิเสธทุกคำขอ)'));
  getMain().catch(() => {}); // โหลดภาษาไว้ก่อน รูปแรกจะได้ไม่ช้า
  // ☕ ปลุกตัวเองทุก 10 นาที (Render ฟรีหลับเมื่อไม่มีคนเรียก 15 นาที) · ปิดได้ด้วย KEEP_AWAKE=0
  const selfUrl = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (selfUrl && process.env.KEEP_AWAKE !== '0') {
    setInterval(() => {
      fetch(selfUrl + '/healthz').catch(e => console.error('⚠️ [Keep-awake] ปลุกตัวเองไม่สำเร็จ:', e.message));
    }, 10 * 60 * 1000);
    console.log('☕ [Keep-awake] ปลุกตัวเองทุก 10 นาที: ' + selfUrl);
  }
});
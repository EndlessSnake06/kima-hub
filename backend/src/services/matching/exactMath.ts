/**
 * exp, log, pow and atan2 built only from operations IEEE 754 and ECMAScript fix exactly (+, −, ×, ÷, √ and bit
 * access), so the map comes out bit for bit the same on every JavaScript engine. JavaScript's own Math.exp, Math.log,
 * Math.pow and Math.atan2 may differ between engines, and Math.pow does differ between Node 20 and Node 24.
 * exp, log and atan2 are fdlibm's algorithms (e_exp.c, e_log.c, s_atan.c, e_atan2.c), the ones V8 ports.
 */

const scratch = new Float64Array(1);
const words = new Int32Array(scratch.buffer);
const HIGH = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LOW = 1 - HIGH;

function high(x: number): number {
    scratch[0] = x;
    return words[HIGH];
}

function low(x: number): number {
    scratch[0] = x;
    return words[LOW] >>> 0;
}

function fromWords(hi: number, lo: number): number {
    words[HIGH] = hi;
    words[LOW] = lo | 0;
    return scratch[0];
}

function withHigh(x: number, hi: number): number {
    scratch[0] = x;
    words[HIGH] = hi;
    return scratch[0];
}

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e0;
const TWO_M1000 = 9.33263618503218878990e-302;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

export function exp(x: number): number {
    let hx = high(x);
    const sign = (hx >>> 31) & 1;
    hx &= 0x7fffffff;
    if (hx >= 0x40862e42) {
        if (hx >= 0x7ff00000) {
            if (((hx & 0xfffff) | low(x)) !== 0) return x + x;
            return sign === 0 ? x : 0;
        }
        if (x > 7.09782712893383973096e2) return Infinity;
        if (x < -7.45133219101941108420e2) return 0;
    }
    let hi = 0;
    let lo = 0;
    let k = 0;
    if (hx > 0x3fd62e42) {
        if (hx < 0x3ff0a2b2) {
            hi = x - (sign === 0 ? LN2_HI : -LN2_HI);
            lo = sign === 0 ? LN2_LO : -LN2_LO;
            k = 1 - sign - sign;
        } else {
            k = Math.trunc(INV_LN2 * x + (sign === 0 ? 0.5 : -0.5));
            hi = x - k * LN2_HI;
            lo = k * LN2_LO;
        }
        x = hi - lo;
    } else if (hx < 0x3e300000) {
        return 1 + x;
    }
    const t = x * x;
    const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k === 0) return 1 - ((x * c) / (c - 2) - x);
    const y = 1 - (lo - (x * c) / (2 - c) - hi);
    if (k >= -1021) {
        if (k === 1024) return y * 2 * fromWords(0x7fe00000, 0);
        return y * fromWords((0x3ff + k) << 20, 0);
    }
    return y * fromWords((0x3ff + k + 1000) << 20, 0) * TWO_M1000;
}

const TWO54 = 1.80143985094819840000e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

export function log(x: number): number {
    let hx = high(x);
    const lx = low(x);
    let k = 0;
    if (hx < 0x00100000) {
        if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
        if (hx < 0) return NaN;
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    const i = (hx + 0x95f64) & 0x100000;
    x = withHigh(x, hx | (i ^ 0x3ff00000));
    k += i >> 20;
    const f = x - 1;
    if ((0x000fffff & (2 + hx)) < 3) {
        if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
        const r = f * f * (0.5 - 0.33333333333333333 * f);
        return k === 0 ? f - r : k * LN2_HI - (r - k * LN2_LO - f);
    }
    const s = f / (2 + f);
    const z = s * s;
    const w = z * z;
    const t1 = w * (LG2 + w * (LG4 + w * LG6));
    const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    const r = t2 + t1;
    if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
        const hfsq = 0.5 * f * f;
        return k === 0 ? f - (hfsq - s * (hfsq + r)) : k * LN2_HI - (hfsq - (s * (hfsq + r) + k * LN2_LO) - f);
    }
    return k === 0 ? f - s * (f - r) : k * LN2_HI - (s * (f - r) - k * LN2_LO - f);
}

/** xʸ for x > 0, as e^(y·ln x); 0 for x = 0 and y > 0. */
export function pow(x: number, y: number): number {
    if (x === 0) return y > 0 ? 0 : Infinity;
    return exp(y * log(x));
}

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
    3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
    9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
    4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

function atan(x: number): number {
    const hx = high(x);
    const ix = hx & 0x7fffffff;
    let id: number;
    if (ix >= 0x44100000) {
        if (ix > 0x7ff00000 || (ix === 0x7ff00000 && low(x) !== 0)) return x + x;
        return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
    }
    if (ix < 0x3fdc0000) {
        if (ix < 0x3e400000) return x;
        id = -1;
    } else {
        x = Math.abs(x);
        if (ix < 0x3ff30000) {
            if (ix < 0x3fe60000) {
                id = 0;
                x = (2 * x - 1) / (2 + x);
            } else {
                id = 1;
                x = (x - 1) / (x + 1);
            }
        } else if (ix < 0x40038000) {
            id = 2;
            x = (x - 1.5) / (1 + 1.5 * x);
        } else {
            id = 3;
            x = -1 / x;
        }
    }
    const z = x * x;
    const w = z * z;
    const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if (id < 0) return x - x * (s1 + s2);
    const r = ATAN_HI[id] - (x * (s1 + s2) - ATAN_LO[id] - x);
    return hx < 0 ? -r : r;
}

const PI = 3.1415926535897931160e0;
const PI_LO = 1.2246467991473531772e-16;
const PI_O_2 = 1.5707963267948965580e0;
const PI_O_4 = 7.8539816339744827900e-1;

/** The angle of (x, y) from the positive x axis, in radians, −π to π. */
export function atan2(y: number, x: number): number {
    if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
    const hx = high(x);
    const ix = hx & 0x7fffffff;
    const lx = low(x);
    const hy = high(y);
    const iy = hy & 0x7fffffff;
    const ly = low(y);
    if (((hx - 0x3ff00000) | lx) === 0) return atan(y);
    let m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2);
    if ((iy | ly) === 0) {
        if (m < 2) return y;
        return m === 2 ? PI : -PI;
    }
    if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 : PI_O_2;
    if (ix === 0x7ff00000) {
        if (iy === 0x7ff00000) return [PI_O_4, -PI_O_4, 3 * PI_O_4, -3 * PI_O_4][m];
        return [0, -0, PI, -PI][m];
    }
    if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2;
    const k = (iy - ix) >> 20;
    let z: number;
    if (k > 60) {
        z = PI_O_2 + 0.5 * PI_LO;
        m &= 1;
    } else if (hx < 0 && k < -60) {
        z = 0;
    } else {
        z = atan(Math.abs(y / x));
    }
    if (m === 0) return z;
    if (m === 1) return -z;
    if (m === 2) return PI - (z - PI_LO);
    return z - PI_LO - PI;
}

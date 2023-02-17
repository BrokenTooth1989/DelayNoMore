"use strict";
(function() {

var $goVersion = "go1.18.6";
Error.stackTraceLimit = Infinity;

var $NaN = NaN;
var $global, $module;
if (typeof window !== "undefined") { /* web page */
  $global = window;
} else if (typeof self !== "undefined") { /* web worker */
  $global = self;
} else if (typeof global !== "undefined") { /* Node.js */
  $global = global;
  $global.require = require;
} else { /* others (e.g. Nashorn) */
  $global = this;
}

if ($global === undefined || $global.Array === undefined) {
  throw new Error("no global object found");
}
if (typeof module !== "undefined") {
  $module = module;
}

if (!$global.fs && $global.require) {
  try {
    var fs = $global.require('fs');
    if (typeof fs === "object" && fs !== null && Object.keys(fs).length !== 0) {
      $global.fs = fs;
    }
  } catch(e) { /* Ignore if the module couldn't be loaded. */ }
}

if (!$global.fs) {
  var outputBuf = "";
  var decoder = new TextDecoder("utf-8");
  $global.fs = {
    constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
    writeSync: function writeSync(fd, buf) {
      outputBuf += decoder.decode(buf);
      var nl = outputBuf.lastIndexOf("\n");
      if (nl != -1) {
        console.log(outputBuf.substr(0, nl));
        outputBuf = outputBuf.substr(nl + 1);
      }
      return buf.length;
    },
    write: function write(fd, buf, offset, length, position, callback) {
      if (offset !== 0 || length !== buf.length || position !== null) {
        callback(enosys());
        return;
      }
      var n = this.writeSync(fd, buf);
      callback(null, n);
    }
  };
}

var $linknames = {} // Collection of functions referenced by a go:linkname directive.
var $packages = {}, $idCounter = 0;
var $keys = function(m) { return m ? Object.keys(m) : []; };
var $flushConsole = function() {};
var $throwRuntimeError; /* set by package "runtime" */
var $throwNilPointerError = function() { $throwRuntimeError("invalid memory address or nil pointer dereference"); };
var $call = function(fn, rcvr, args) { return fn.apply(rcvr, args); };
var $makeFunc = function(fn) { return function() { return $externalize(fn(this, new ($sliceType($jsObjectPtr))($global.Array.prototype.slice.call(arguments, []))), $emptyInterface); }; };
var $unused = function(v) {};
var $print = console.log;
// Under Node we can emulate print() more closely by avoiding a newline.
if (($global.process !== undefined) && $global.require) {
  try {
    var util = $global.require('util');
    $print = function() { $global.process.stderr.write(util.format.apply(this, arguments)); };
  } catch (e) {
    // Failed to require util module, keep using console.log().
  }
}
var $println = console.log

var $initAllLinknames = function() {
  var names = $keys($packages);
  for (var i = 0; i < names.length; i++) {
    var f = $packages[names[i]]["$initLinknames"];
    if (typeof f == 'function') {
      f();
    }
  }
}

var $mapArray = function(array, f) {
  var newArray = new array.constructor(array.length);
  for (var i = 0; i < array.length; i++) {
    newArray[i] = f(array[i]);
  }
  return newArray;
};

// Returns a method bound to the receiver instance, safe to invoke as a 
// standalone function. Bound function is cached for later reuse.
var $methodVal = function(recv, name) {
  var vals = recv.$methodVals || {};
  recv.$methodVals = vals; /* noop for primitives */
  var f = vals[name];
  if (f !== undefined) {
    return f;
  }
  var method = recv[name];
  f = method.bind(recv);
  vals[name] = f;
  return f;
};

var $methodExpr = function(typ, name) {
  var method = typ.prototype[name];
  if (method.$expr === undefined) {
    method.$expr = function() {
      $stackDepthOffset--;
      try {
        if (typ.wrapped) {
          arguments[0] = new typ(arguments[0]);
        }
        return Function.call.apply(method, arguments);
      } finally {
        $stackDepthOffset++;
      }
    };
  }
  return method.$expr;
};

var $ifaceMethodExprs = {};
var $ifaceMethodExpr = function(name) {
  var expr = $ifaceMethodExprs["$" + name];
  if (expr === undefined) {
    expr = $ifaceMethodExprs["$" + name] = function() {
      $stackDepthOffset--;
      try {
        return Function.call.apply(arguments[0][name], arguments);
      } finally {
        $stackDepthOffset++;
      }
    };
  }
  return expr;
};

var $subslice = function(slice, low, high, max) {
  if (high === undefined) {
    high = slice.$length;
  }
  if (max === undefined) {
    max = slice.$capacity;
  }
  if (low < 0 || high < low || max < high || high > slice.$capacity || max > slice.$capacity) {
    $throwRuntimeError("slice bounds out of range");
  }
  if (slice === slice.constructor.nil) {
    return slice;
  }
  var s = new slice.constructor(slice.$array);
  s.$offset = slice.$offset + low;
  s.$length = high - low;
  s.$capacity = max - low;
  return s;
};

var $substring = function(str, low, high) {
  if (low < 0 || high < low || high > str.length) {
    $throwRuntimeError("slice bounds out of range");
  }
  return str.substring(low, high);
};

// Convert Go slice to an equivalent JS array type.
var $sliceToNativeArray = function(slice) {
  if (slice.$array.constructor !== Array) {
    return slice.$array.subarray(slice.$offset, slice.$offset + slice.$length);
  }
  return slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
};

// Convert Go slice to a pointer to an underlying Go array.
// 
// Note that an array pointer can be represented by an "unwrapped" native array
// type, and it will be wrapped back into its Go type when necessary.
var $sliceToGoArray = function(slice, arrayPtrType) {
  var arrayType = arrayPtrType.elem;
  if (arrayType !== undefined && slice.$length < arrayType.len) {
    $throwRuntimeError("cannot convert slice with length " + slice.$length + " to pointer to array with length " + arrayType.len);
  }
  if (slice == slice.constructor.nil) {
    return arrayPtrType.nil; // Nil slice converts to nil array pointer.
  }
  if (slice.$array.constructor !== Array) {
    return slice.$array.subarray(slice.$offset, slice.$offset + arrayType.len);
  }
  if (slice.$offset == 0 && slice.$length == slice.$capacity && slice.$length == arrayType.len) {
    return slice.$array;
  }
  if (arrayType.len == 0) {
    return new arrayType([]);
  }

  // Array.slice (unlike TypedArray.subarray) returns a copy of an array range,
  // which is not sharing memory with the original one, which violates the spec
  // for slice to array conversion. This is incompatible with the Go spec, in
  // particular that the assignments to the array elements would be visible in
  // the slice. Prefer to fail explicitly instead of creating subtle bugs.
  $throwRuntimeError("gopherjs: non-numeric slice to underlying array conversion is not supported for subslices");
};

// Convert between compatible slice types (e.g. native and names).
var $convertSliceType = function(slice, desiredType) {
  if (slice == slice.constructor.nil) {
    return desiredType.nil; // Preserve nil value.
  }

  return $subslice(new desiredType(slice.$array), slice.$offset, slice.$offset + slice.$length);
}

var $decodeRune = function(str, pos) {
  var c0 = str.charCodeAt(pos);

  if (c0 < 0x80) {
    return [c0, 1];
  }

  if (c0 !== c0 || c0 < 0xC0) {
    return [0xFFFD, 1];
  }

  var c1 = str.charCodeAt(pos + 1);
  if (c1 !== c1 || c1 < 0x80 || 0xC0 <= c1) {
    return [0xFFFD, 1];
  }

  if (c0 < 0xE0) {
    var r = (c0 & 0x1F) << 6 | (c1 & 0x3F);
    if (r <= 0x7F) {
      return [0xFFFD, 1];
    }
    return [r, 2];
  }

  var c2 = str.charCodeAt(pos + 2);
  if (c2 !== c2 || c2 < 0x80 || 0xC0 <= c2) {
    return [0xFFFD, 1];
  }

  if (c0 < 0xF0) {
    var r = (c0 & 0x0F) << 12 | (c1 & 0x3F) << 6 | (c2 & 0x3F);
    if (r <= 0x7FF) {
      return [0xFFFD, 1];
    }
    if (0xD800 <= r && r <= 0xDFFF) {
      return [0xFFFD, 1];
    }
    return [r, 3];
  }

  var c3 = str.charCodeAt(pos + 3);
  if (c3 !== c3 || c3 < 0x80 || 0xC0 <= c3) {
    return [0xFFFD, 1];
  }

  if (c0 < 0xF8) {
    var r = (c0 & 0x07) << 18 | (c1 & 0x3F) << 12 | (c2 & 0x3F) << 6 | (c3 & 0x3F);
    if (r <= 0xFFFF || 0x10FFFF < r) {
      return [0xFFFD, 1];
    }
    return [r, 4];
  }

  return [0xFFFD, 1];
};

var $encodeRune = function(r) {
  if (r < 0 || r > 0x10FFFF || (0xD800 <= r && r <= 0xDFFF)) {
    r = 0xFFFD;
  }
  if (r <= 0x7F) {
    return String.fromCharCode(r);
  }
  if (r <= 0x7FF) {
    return String.fromCharCode(0xC0 | r >> 6, 0x80 | (r & 0x3F));
  }
  if (r <= 0xFFFF) {
    return String.fromCharCode(0xE0 | r >> 12, 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
  }
  return String.fromCharCode(0xF0 | r >> 18, 0x80 | (r >> 12 & 0x3F), 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
};

var $stringToBytes = function(str) {
  var array = new Uint8Array(str.length);
  for (var i = 0; i < str.length; i++) {
    array[i] = str.charCodeAt(i);
  }
  return array;
};

var $bytesToString = function(slice) {
  if (slice.$length === 0) {
    return "";
  }
  var str = "";
  for (var i = 0; i < slice.$length; i += 10000) {
    str += String.fromCharCode.apply(undefined, slice.$array.subarray(slice.$offset + i, slice.$offset + Math.min(slice.$length, i + 10000)));
  }
  return str;
};

var $stringToRunes = function(str) {
  var array = new Int32Array(str.length);
  var rune, j = 0;
  for (var i = 0; i < str.length; i += rune[1], j++) {
    rune = $decodeRune(str, i);
    array[j] = rune[0];
  }
  return array.subarray(0, j);
};

var $runesToString = function(slice) {
  if (slice.$length === 0) {
    return "";
  }
  var str = "";
  for (var i = 0; i < slice.$length; i++) {
    str += $encodeRune(slice.$array[slice.$offset + i]);
  }
  return str;
};

var $copyString = function(dst, src) {
  var n = Math.min(src.length, dst.$length);
  for (var i = 0; i < n; i++) {
    dst.$array[dst.$offset + i] = src.charCodeAt(i);
  }
  return n;
};

var $copySlice = function(dst, src) {
  var n = Math.min(src.$length, dst.$length);
  $copyArray(dst.$array, src.$array, dst.$offset, src.$offset, n, dst.constructor.elem);
  return n;
};

var $copyArray = function(dst, src, dstOffset, srcOffset, n, elem) {
  if (n === 0 || (dst === src && dstOffset === srcOffset)) {
    return;
  }

  if (src.subarray) {
    dst.set(src.subarray(srcOffset, srcOffset + n), dstOffset);
    return;
  }

  switch (elem.kind) {
  case $kindArray:
  case $kindStruct:
    if (dst === src && dstOffset > srcOffset) {
      for (var i = n - 1; i >= 0; i--) {
        elem.copy(dst[dstOffset + i], src[srcOffset + i]);
      }
      return;
    }
    for (var i = 0; i < n; i++) {
      elem.copy(dst[dstOffset + i], src[srcOffset + i]);
    }
    return;
  }

  if (dst === src && dstOffset > srcOffset) {
    for (var i = n - 1; i >= 0; i--) {
      dst[dstOffset + i] = src[srcOffset + i];
    }
    return;
  }
  for (var i = 0; i < n; i++) {
    dst[dstOffset + i] = src[srcOffset + i];
  }
};

var $clone = function(src, type) {
  var clone = type.zero();
  type.copy(clone, src);
  return clone;
};

var $pointerOfStructConversion = function(obj, type) {
  if(obj.$proxies === undefined) {
    obj.$proxies = {};
    obj.$proxies[obj.constructor.string] = obj;
  }
  var proxy = obj.$proxies[type.string];
  if (proxy === undefined) {
    var properties = {};
    for (var i = 0; i < type.elem.fields.length; i++) {
      (function(fieldProp) {
        properties[fieldProp] = {
          get: function() { return obj[fieldProp]; },
          set: function(value) { obj[fieldProp] = value; }
        };
      })(type.elem.fields[i].prop);
    }
    proxy = Object.create(type.prototype, properties);
    proxy.$val = proxy;
    obj.$proxies[type.string] = proxy;
    proxy.$proxies = obj.$proxies;
  }
  return proxy;
};

var $append = function(slice) {
  return $internalAppend(slice, arguments, 1, arguments.length - 1);
};

var $appendSlice = function(slice, toAppend) {
  if (toAppend.constructor === String) {
    var bytes = $stringToBytes(toAppend);
    return $internalAppend(slice, bytes, 0, bytes.length);
  }
  return $internalAppend(slice, toAppend.$array, toAppend.$offset, toAppend.$length);
};

var $internalAppend = function(slice, array, offset, length) {
  if (length === 0) {
    return slice;
  }

  var newArray = slice.$array;
  var newOffset = slice.$offset;
  var newLength = slice.$length + length;
  var newCapacity = slice.$capacity;

  if (newLength > newCapacity) {
    newOffset = 0;
    newCapacity = Math.max(newLength, slice.$capacity < 1024 ? slice.$capacity * 2 : Math.floor(slice.$capacity * 5 / 4));

    if (slice.$array.constructor === Array) {
      newArray = slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
      newArray.length = newCapacity;
      var zero = slice.constructor.elem.zero;
      for (var i = slice.$length; i < newCapacity; i++) {
        newArray[i] = zero();
      }
    } else {
      newArray = new slice.$array.constructor(newCapacity);
      newArray.set(slice.$array.subarray(slice.$offset, slice.$offset + slice.$length));
    }
  }

  $copyArray(newArray, array, newOffset + slice.$length, offset, length, slice.constructor.elem);

  var newSlice = new slice.constructor(newArray);
  newSlice.$offset = newOffset;
  newSlice.$length = newLength;
  newSlice.$capacity = newCapacity;
  return newSlice;
};

var $equal = function(a, b, type) {
  if (type === $jsObjectPtr) {
    return a === b;
  }
  switch (type.kind) {
  case $kindComplex64:
  case $kindComplex128:
    return a.$real === b.$real && a.$imag === b.$imag;
  case $kindInt64:
  case $kindUint64:
    return a.$high === b.$high && a.$low === b.$low;
  case $kindArray:
    if (a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if (!$equal(a[i], b[i], type.elem)) {
        return false;
      }
    }
    return true;
  case $kindStruct:
    for (var i = 0; i < type.fields.length; i++) {
      var f = type.fields[i];
      if (!$equal(a[f.prop], b[f.prop], f.typ)) {
        return false;
      }
    }
    return true;
  case $kindInterface:
    return $interfaceIsEqual(a, b);
  default:
    return a === b;
  }
};

var $interfaceIsEqual = function(a, b) {
  if (a === $ifaceNil || b === $ifaceNil) {
    return a === b;
  }
  if (a.constructor !== b.constructor) {
    return false;
  }
  if (a.constructor === $jsObjectPtr) {
    return a.object === b.object;
  }
  if (!a.constructor.comparable) {
    $throwRuntimeError("comparing uncomparable type " + a.constructor.string);
  }
  return $equal(a.$val, b.$val, a.constructor);
};

var $min = Math.min;
var $mod = function(x, y) { return x % y; };
var $parseInt = parseInt;
var $parseFloat = function(f) {
  if (f !== undefined && f !== null && f.constructor === Number) {
    return f;
  }
  return parseFloat(f);
};

var $froundBuf = new Float32Array(1);
var $fround = Math.fround || function(f) {
  $froundBuf[0] = f;
  return $froundBuf[0];
};

var $imul = Math.imul || function(a, b) {
  var ah = (a >>> 16) & 0xffff;
  var al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff;
  var bl = b & 0xffff;
  return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) >> 0);
};

var $floatKey = function(f) {
  if (f !== f) {
    $idCounter++;
    return "NaN$" + $idCounter;
  }
  return String(f);
};

var $flatten64 = function(x) {
  return x.$high * 4294967296 + x.$low;
};

var $shiftLeft64 = function(x, y) {
  if (y === 0) {
    return x;
  }
  if (y < 32) {
    return new x.constructor(x.$high << y | x.$low >>> (32 - y), (x.$low << y) >>> 0);
  }
  if (y < 64) {
    return new x.constructor(x.$low << (y - 32), 0);
  }
  return new x.constructor(0, 0);
};

var $shiftRightInt64 = function(x, y) {
  if (y === 0) {
    return x;
  }
  if (y < 32) {
    return new x.constructor(x.$high >> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
  }
  if (y < 64) {
    return new x.constructor(x.$high >> 31, (x.$high >> (y - 32)) >>> 0);
  }
  if (x.$high < 0) {
    return new x.constructor(-1, 4294967295);
  }
  return new x.constructor(0, 0);
};

var $shiftRightUint64 = function(x, y) {
  if (y === 0) {
    return x;
  }
  if (y < 32) {
    return new x.constructor(x.$high >>> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
  }
  if (y < 64) {
    return new x.constructor(0, x.$high >>> (y - 32));
  }
  return new x.constructor(0, 0);
};

var $mul64 = function(x, y) {
  var x48 = x.$high >>> 16;
  var x32 = x.$high & 0xFFFF;
  var x16 = x.$low >>> 16;
  var x00 = x.$low & 0xFFFF;

  var y48 = y.$high >>> 16;
  var y32 = y.$high & 0xFFFF;
  var y16 = y.$low >>> 16;
  var y00 = y.$low & 0xFFFF;

  var z48 = 0, z32 = 0, z16 = 0, z00 = 0;
  z00 += x00 * y00;
  z16 += z00 >>> 16;
  z00 &= 0xFFFF;
  z16 += x16 * y00;
  z32 += z16 >>> 16;
  z16 &= 0xFFFF;
  z16 += x00 * y16;
  z32 += z16 >>> 16;
  z16 &= 0xFFFF;
  z32 += x32 * y00;
  z48 += z32 >>> 16;
  z32 &= 0xFFFF;
  z32 += x16 * y16;
  z48 += z32 >>> 16;
  z32 &= 0xFFFF;
  z32 += x00 * y32;
  z48 += z32 >>> 16;
  z32 &= 0xFFFF;
  z48 += x48 * y00 + x32 * y16 + x16 * y32 + x00 * y48;
  z48 &= 0xFFFF;

  var hi = ((z48 << 16) | z32) >>> 0;
  var lo = ((z16 << 16) | z00) >>> 0;

  var r = new x.constructor(hi, lo);
  return r;
};

var $div64 = function(x, y, returnRemainder) {
  if (y.$high === 0 && y.$low === 0) {
    $throwRuntimeError("integer divide by zero");
  }

  var s = 1;
  var rs = 1;

  var xHigh = x.$high;
  var xLow = x.$low;
  if (xHigh < 0) {
    s = -1;
    rs = -1;
    xHigh = -xHigh;
    if (xLow !== 0) {
      xHigh--;
      xLow = 4294967296 - xLow;
    }
  }

  var yHigh = y.$high;
  var yLow = y.$low;
  if (y.$high < 0) {
    s *= -1;
    yHigh = -yHigh;
    if (yLow !== 0) {
      yHigh--;
      yLow = 4294967296 - yLow;
    }
  }

  var high = 0, low = 0, n = 0;
  while (yHigh < 2147483648 && ((xHigh > yHigh) || (xHigh === yHigh && xLow > yLow))) {
    yHigh = (yHigh << 1 | yLow >>> 31) >>> 0;
    yLow = (yLow << 1) >>> 0;
    n++;
  }
  for (var i = 0; i <= n; i++) {
    high = high << 1 | low >>> 31;
    low = (low << 1) >>> 0;
    if ((xHigh > yHigh) || (xHigh === yHigh && xLow >= yLow)) {
      xHigh = xHigh - yHigh;
      xLow = xLow - yLow;
      if (xLow < 0) {
        xHigh--;
        xLow += 4294967296;
      }
      low++;
      if (low === 4294967296) {
        high++;
        low = 0;
      }
    }
    yLow = (yLow >>> 1 | yHigh << (32 - 1)) >>> 0;
    yHigh = yHigh >>> 1;
  }

  if (returnRemainder) {
    return new x.constructor(xHigh * rs, xLow * rs);
  }
  return new x.constructor(high * s, low * s);
};

var $divComplex = function(n, d) {
  var ninf = n.$real === Infinity || n.$real === -Infinity || n.$imag === Infinity || n.$imag === -Infinity;
  var dinf = d.$real === Infinity || d.$real === -Infinity || d.$imag === Infinity || d.$imag === -Infinity;
  var nnan = !ninf && (n.$real !== n.$real || n.$imag !== n.$imag);
  var dnan = !dinf && (d.$real !== d.$real || d.$imag !== d.$imag);
  if(nnan || dnan) {
    return new n.constructor(NaN, NaN);
  }
  if (ninf && !dinf) {
    return new n.constructor(Infinity, Infinity);
  }
  if (!ninf && dinf) {
    return new n.constructor(0, 0);
  }
  if (d.$real === 0 && d.$imag === 0) {
    if (n.$real === 0 && n.$imag === 0) {
      return new n.constructor(NaN, NaN);
    }
    return new n.constructor(Infinity, Infinity);
  }
  var a = Math.abs(d.$real);
  var b = Math.abs(d.$imag);
  if (a <= b) {
    var ratio = d.$real / d.$imag;
    var denom = d.$real * ratio + d.$imag;
    return new n.constructor((n.$real * ratio + n.$imag) / denom, (n.$imag * ratio - n.$real) / denom);
  }
  var ratio = d.$imag / d.$real;
  var denom = d.$imag * ratio + d.$real;
  return new n.constructor((n.$imag * ratio + n.$real) / denom, (n.$imag - n.$real * ratio) / denom);
};

var $kindBool = 1;
var $kindInt = 2;
var $kindInt8 = 3;
var $kindInt16 = 4;
var $kindInt32 = 5;
var $kindInt64 = 6;
var $kindUint = 7;
var $kindUint8 = 8;
var $kindUint16 = 9;
var $kindUint32 = 10;
var $kindUint64 = 11;
var $kindUintptr = 12;
var $kindFloat32 = 13;
var $kindFloat64 = 14;
var $kindComplex64 = 15;
var $kindComplex128 = 16;
var $kindArray = 17;
var $kindChan = 18;
var $kindFunc = 19;
var $kindInterface = 20;
var $kindMap = 21;
var $kindPtr = 22;
var $kindSlice = 23;
var $kindString = 24;
var $kindStruct = 25;
var $kindUnsafePointer = 26;

var $methodSynthesizers = [];
var $addMethodSynthesizer = function(f) {
  if ($methodSynthesizers === null) {
    f();
    return;
  }
  $methodSynthesizers.push(f);
};
var $synthesizeMethods = function() {
  $methodSynthesizers.forEach(function(f) { f(); });
  $methodSynthesizers = null;
};

var $ifaceKeyFor = function(x) {
  if (x === $ifaceNil) {
    return 'nil';
  }
  var c = x.constructor;
  return c.string + '$' + c.keyFor(x.$val);
};

var $identity = function(x) { return x; };

var $typeIDCounter = 0;

var $idKey = function(x) {
  if (x.$id === undefined) {
    $idCounter++;
    x.$id = $idCounter;
  }
  return String(x.$id);
};

// Creates constructor functions for array pointer types. Returns a new function
// instace each time to make sure each type is independent of the other.
var $arrayPtrCtor = function() {
  return function(array) {
    this.$get = function() { return array; };
    this.$set = function(v) { typ.copy(this, v); };
    this.$val = array;
  }
}

var $newType = function(size, kind, string, named, pkg, exported, constructor) {
  var typ;
  switch(kind) {
  case $kindBool:
  case $kindInt:
  case $kindInt8:
  case $kindInt16:
  case $kindInt32:
  case $kindUint:
  case $kindUint8:
  case $kindUint16:
  case $kindUint32:
  case $kindUintptr:
  case $kindUnsafePointer:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = $identity;
    break;

  case $kindString:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = function(x) { return "$" + x; };
    break;

  case $kindFloat32:
  case $kindFloat64:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = function(x) { return $floatKey(x); };
    break;

  case $kindInt64:
    typ = function(high, low) {
      this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >> 0;
      this.$low = low >>> 0;
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$high + "$" + x.$low; };
    break;

  case $kindUint64:
    typ = function(high, low) {
      this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >>> 0;
      this.$low = low >>> 0;
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$high + "$" + x.$low; };
    break;

  case $kindComplex64:
    typ = function(real, imag) {
      this.$real = $fround(real);
      this.$imag = $fround(imag);
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$real + "$" + x.$imag; };
    break;

  case $kindComplex128:
    typ = function(real, imag) {
      this.$real = real;
      this.$imag = imag;
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$real + "$" + x.$imag; };
    break;

  case $kindArray:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.ptr = $newType(4, $kindPtr, "*" + string, false, "", false, $arrayPtrCtor());
    typ.init = function(elem, len) {
      typ.elem = elem;
      typ.len = len;
      typ.comparable = elem.comparable;
      typ.keyFor = function(x) {
        return Array.prototype.join.call($mapArray(x, function(e) {
          return String(elem.keyFor(e)).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
        }), "$");
      };
      typ.copy = function(dst, src) {
        $copyArray(dst, src, 0, 0, src.length, elem);
      };
      typ.ptr.init(typ);
      Object.defineProperty(typ.ptr.nil, "nilCheck", { get: $throwNilPointerError });
    };
    break;

  case $kindChan:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = $idKey;
    typ.init = function(elem, sendOnly, recvOnly) {
      typ.elem = elem;
      typ.sendOnly = sendOnly;
      typ.recvOnly = recvOnly;
    };
    break;

  case $kindFunc:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.init = function(params, results, variadic) {
      typ.params = params;
      typ.results = results;
      typ.variadic = variadic;
      typ.comparable = false;
    };
    break;

  case $kindInterface:
    typ = { implementedBy: {}, missingMethodFor: {} };
    typ.keyFor = $ifaceKeyFor;
    typ.init = function(methods) {
      typ.methods = methods;
      methods.forEach(function(m) {
        $ifaceNil[m.prop] = $throwNilPointerError;
      });
    };
    break;

  case $kindMap:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.init = function(key, elem) {
      typ.key = key;
      typ.elem = elem;
      typ.comparable = false;
    };
    break;

  case $kindPtr:
    typ = constructor || function(getter, setter, target) {
      this.$get = getter;
      this.$set = setter;
      this.$target = target;
      this.$val = this;
    };
    typ.keyFor = $idKey;
    typ.init = function(elem) {
      typ.elem = elem;
      typ.wrapped = (elem.kind === $kindArray);
      typ.nil = new typ($throwNilPointerError, $throwNilPointerError);
    };
    break;

  case $kindSlice:
    typ = function(array) {
      if (array.constructor !== typ.nativeArray) {
        array = new typ.nativeArray(array);
      }
      this.$array = array;
      this.$offset = 0;
      this.$length = array.length;
      this.$capacity = array.length;
      this.$val = this;
    };
    typ.init = function(elem) {
      typ.elem = elem;
      typ.comparable = false;
      typ.nativeArray = $nativeArray(elem.kind);
      typ.nil = new typ([]);
    };
    break;

  case $kindStruct:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.ptr = $newType(4, $kindPtr, "*" + string, false, pkg, exported, constructor);
    typ.ptr.elem = typ;
    typ.ptr.prototype.$get = function() { return this; };
    typ.ptr.prototype.$set = function(v) { typ.copy(this, v); };
    typ.init = function(pkgPath, fields) {
      typ.pkgPath = pkgPath;
      typ.fields = fields;
      fields.forEach(function(f) {
        if (!f.typ.comparable) {
          typ.comparable = false;
        }
      });
      typ.keyFor = function(x) {
        var val = x.$val;
        return $mapArray(fields, function(f) {
          return String(f.typ.keyFor(val[f.prop])).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
        }).join("$");
      };
      typ.copy = function(dst, src) {
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          switch (f.typ.kind) {
          case $kindArray:
          case $kindStruct:
            f.typ.copy(dst[f.prop], src[f.prop]);
            continue;
          default:
            dst[f.prop] = src[f.prop];
            continue;
          }
        }
      };
      /* nil value */
      var properties = {};
      fields.forEach(function(f) {
        properties[f.prop] = { get: $throwNilPointerError, set: $throwNilPointerError };
      });
      typ.ptr.nil = Object.create(constructor.prototype, properties);
      typ.ptr.nil.$val = typ.ptr.nil;
      /* methods for embedded fields */
      $addMethodSynthesizer(function() {
        var synthesizeMethod = function(target, m, f) {
          if (target.prototype[m.prop] !== undefined) { return; }
          target.prototype[m.prop] = function() {
            var v = this.$val[f.prop];
            if (f.typ === $jsObjectPtr) {
              v = new $jsObjectPtr(v);
            }
            if (v.$val === undefined) {
              v = new f.typ(v);
            }
            return v[m.prop].apply(v, arguments);
          };
        };
        fields.forEach(function(f) {
          if (f.embedded) {
            $methodSet(f.typ).forEach(function(m) {
              synthesizeMethod(typ, m, f);
              synthesizeMethod(typ.ptr, m, f);
            });
            $methodSet($ptrType(f.typ)).forEach(function(m) {
              synthesizeMethod(typ.ptr, m, f);
            });
          }
        });
      });
    };
    break;

  default:
    $panic(new $String("invalid kind: " + kind));
  }

  switch (kind) {
  case $kindBool:
  case $kindMap:
    typ.zero = function() { return false; };
    break;

  case $kindInt:
  case $kindInt8:
  case $kindInt16:
  case $kindInt32:
  case $kindUint:
  case $kindUint8 :
  case $kindUint16:
  case $kindUint32:
  case $kindUintptr:
  case $kindUnsafePointer:
  case $kindFloat32:
  case $kindFloat64:
    typ.zero = function() { return 0; };
    break;

  case $kindString:
    typ.zero = function() { return ""; };
    break;

  case $kindInt64:
  case $kindUint64:
  case $kindComplex64:
  case $kindComplex128:
    var zero = new typ(0, 0);
    typ.zero = function() { return zero; };
    break;

  case $kindPtr:
  case $kindSlice:
    typ.zero = function() { return typ.nil; };
    break;

  case $kindChan:
    typ.zero = function() { return $chanNil; };
    break;

  case $kindFunc:
    typ.zero = function() { return $throwNilPointerError; };
    break;

  case $kindInterface:
    typ.zero = function() { return $ifaceNil; };
    break;

  case $kindArray:
    typ.zero = function() {
      var arrayClass = $nativeArray(typ.elem.kind);
      if (arrayClass !== Array) {
        return new arrayClass(typ.len);
      }
      var array = new Array(typ.len);
      for (var i = 0; i < typ.len; i++) {
        array[i] = typ.elem.zero();
      }
      return array;
    };
    break;

  case $kindStruct:
    typ.zero = function() { return new typ.ptr(); };
    break;

  default:
    $panic(new $String("invalid kind: " + kind));
  }

  typ.id = $typeIDCounter;
  $typeIDCounter++;
  typ.size = size;
  typ.kind = kind;
  typ.string = string;
  typ.named = named;
  typ.pkg = pkg;
  typ.exported = exported;
  typ.methods = [];
  typ.methodSetCache = null;
  typ.comparable = true;
  return typ;
};

var $methodSet = function(typ) {
  if (typ.methodSetCache !== null) {
    return typ.methodSetCache;
  }
  var base = {};

  var isPtr = (typ.kind === $kindPtr);
  if (isPtr && typ.elem.kind === $kindInterface) {
    typ.methodSetCache = [];
    return [];
  }

  var current = [{typ: isPtr ? typ.elem : typ, indirect: isPtr}];

  var seen = {};

  while (current.length > 0) {
    var next = [];
    var mset = [];

    current.forEach(function(e) {
      if (seen[e.typ.string]) {
        return;
      }
      seen[e.typ.string] = true;

      if (e.typ.named) {
        mset = mset.concat(e.typ.methods);
        if (e.indirect) {
          mset = mset.concat($ptrType(e.typ).methods);
        }
      }

      switch (e.typ.kind) {
      case $kindStruct:
        e.typ.fields.forEach(function(f) {
          if (f.embedded) {
            var fTyp = f.typ;
            var fIsPtr = (fTyp.kind === $kindPtr);
            next.push({typ: fIsPtr ? fTyp.elem : fTyp, indirect: e.indirect || fIsPtr});
          }
        });
        break;

      case $kindInterface:
        mset = mset.concat(e.typ.methods);
        break;
      }
    });

    mset.forEach(function(m) {
      if (base[m.name] === undefined) {
        base[m.name] = m;
      }
    });

    current = next;
  }

  typ.methodSetCache = [];
  Object.keys(base).sort().forEach(function(name) {
    typ.methodSetCache.push(base[name]);
  });
  return typ.methodSetCache;
};

var $Bool          = $newType( 1, $kindBool,          "bool",           true, "", false, null);
var $Int           = $newType( 4, $kindInt,           "int",            true, "", false, null);
var $Int8          = $newType( 1, $kindInt8,          "int8",           true, "", false, null);
var $Int16         = $newType( 2, $kindInt16,         "int16",          true, "", false, null);
var $Int32         = $newType( 4, $kindInt32,         "int32",          true, "", false, null);
var $Int64         = $newType( 8, $kindInt64,         "int64",          true, "", false, null);
var $Uint          = $newType( 4, $kindUint,          "uint",           true, "", false, null);
var $Uint8         = $newType( 1, $kindUint8,         "uint8",          true, "", false, null);
var $Uint16        = $newType( 2, $kindUint16,        "uint16",         true, "", false, null);
var $Uint32        = $newType( 4, $kindUint32,        "uint32",         true, "", false, null);
var $Uint64        = $newType( 8, $kindUint64,        "uint64",         true, "", false, null);
var $Uintptr       = $newType( 4, $kindUintptr,       "uintptr",        true, "", false, null);
var $Float32       = $newType( 4, $kindFloat32,       "float32",        true, "", false, null);
var $Float64       = $newType( 8, $kindFloat64,       "float64",        true, "", false, null);
var $Complex64     = $newType( 8, $kindComplex64,     "complex64",      true, "", false, null);
var $Complex128    = $newType(16, $kindComplex128,    "complex128",     true, "", false, null);
var $String        = $newType( 8, $kindString,        "string",         true, "", false, null);
var $UnsafePointer = $newType( 4, $kindUnsafePointer, "unsafe.Pointer", true, "unsafe", false, null);

var $nativeArray = function(elemKind) {
  switch (elemKind) {
  case $kindInt:
    return Int32Array;
  case $kindInt8:
    return Int8Array;
  case $kindInt16:
    return Int16Array;
  case $kindInt32:
    return Int32Array;
  case $kindUint:
    return Uint32Array;
  case $kindUint8:
    return Uint8Array;
  case $kindUint16:
    return Uint16Array;
  case $kindUint32:
    return Uint32Array;
  case $kindUintptr:
    return Uint32Array;
  case $kindFloat32:
    return Float32Array;
  case $kindFloat64:
    return Float64Array;
  default:
    return Array;
  }
};
var $toNativeArray = function(elemKind, array) {
  var nativeArray = $nativeArray(elemKind);
  if (nativeArray === Array) {
    return array;
  }
  return new nativeArray(array);
};
var $arrayTypes = {};
var $arrayType = function(elem, len) {
  var typeKey = elem.id + "$" + len;
  var typ = $arrayTypes[typeKey];
  if (typ === undefined) {
    typ = $newType(12, $kindArray, "[" + len + "]" + elem.string, false, "", false, null);
    $arrayTypes[typeKey] = typ;
    typ.init(elem, len);
  }
  return typ;
};

var $chanType = function(elem, sendOnly, recvOnly) {
  var string = (recvOnly ? "<-" : "") + "chan" + (sendOnly ? "<- " : " ");
  if (!sendOnly && !recvOnly && (elem.string[0] == "<")) {
    string += "(" + elem.string + ")";
  } else {
    string += elem.string;
  }
  var field = sendOnly ? "SendChan" : (recvOnly ? "RecvChan" : "Chan");
  var typ = elem[field];
  if (typ === undefined) {
    typ = $newType(4, $kindChan, string, false, "", false, null);
    elem[field] = typ;
    typ.init(elem, sendOnly, recvOnly);
  }
  return typ;
};
var $Chan = function(elem, capacity) {
  if (capacity < 0 || capacity > 2147483647) {
    $throwRuntimeError("makechan: size out of range");
  }
  this.$elem = elem;
  this.$capacity = capacity;
  this.$buffer = [];
  this.$sendQueue = [];
  this.$recvQueue = [];
  this.$closed = false;
};
var $chanNil = new $Chan(null, 0);
$chanNil.$sendQueue = $chanNil.$recvQueue = { length: 0, push: function() {}, shift: function() { return undefined; }, indexOf: function() { return -1; } };

var $funcTypes = {};
var $funcType = function(params, results, variadic) {
  var typeKey = $mapArray(params, function(p) { return p.id; }).join(",") + "$" + $mapArray(results, function(r) { return r.id; }).join(",") + "$" + variadic;
  var typ = $funcTypes[typeKey];
  if (typ === undefined) {
    var paramTypes = $mapArray(params, function(p) { return p.string; });
    if (variadic) {
      paramTypes[paramTypes.length - 1] = "..." + paramTypes[paramTypes.length - 1].substr(2);
    }
    var string = "func(" + paramTypes.join(", ") + ")";
    if (results.length === 1) {
      string += " " + results[0].string;
    } else if (results.length > 1) {
      string += " (" + $mapArray(results, function(r) { return r.string; }).join(", ") + ")";
    }
    typ = $newType(4, $kindFunc, string, false, "", false, null);
    $funcTypes[typeKey] = typ;
    typ.init(params, results, variadic);
  }
  return typ;
};

var $interfaceTypes = {};
var $interfaceType = function(methods) {
  var typeKey = $mapArray(methods, function(m) { return m.pkg + "," + m.name + "," + m.typ.id; }).join("$");
  var typ = $interfaceTypes[typeKey];
  if (typ === undefined) {
    var string = "interface {}";
    if (methods.length !== 0) {
      string = "interface { " + $mapArray(methods, function(m) {
        return (m.pkg !== "" ? m.pkg + "." : "") + m.name + m.typ.string.substr(4);
      }).join("; ") + " }";
    }
    typ = $newType(8, $kindInterface, string, false, "", false, null);
    $interfaceTypes[typeKey] = typ;
    typ.init(methods);
  }
  return typ;
};
var $emptyInterface = $interfaceType([]);
var $ifaceNil = {};
var $error = $newType(8, $kindInterface, "error", true, "", false, null);
$error.init([{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}]);

var $mapTypes = {};
var $mapType = function(key, elem) {
  var typeKey = key.id + "$" + elem.id;
  var typ = $mapTypes[typeKey];
  if (typ === undefined) {
    typ = $newType(4, $kindMap, "map[" + key.string + "]" + elem.string, false, "", false, null);
    $mapTypes[typeKey] = typ;
    typ.init(key, elem);
  }
  return typ;
};
var $makeMap = function(keyForFunc, entries) {
  var m = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    m[keyForFunc(e.k)] = e;
  }
  return m;
};

var $ptrType = function(elem) {
  var typ = elem.ptr;
  if (typ === undefined) {
    typ = $newType(4, $kindPtr, "*" + elem.string, false, "", elem.exported, null);
    elem.ptr = typ;
    typ.init(elem);
  }
  return typ;
};

var $newDataPointer = function(data, constructor) {
  if (constructor.elem.kind === $kindStruct) {
    return data;
  }
  return new constructor(function() { return data; }, function(v) { data = v; });
};

var $indexPtr = function(array, index, constructor) {
  if (array.buffer) {
    // Pointers to the same underlying ArrayBuffer share cache.
    var cache = array.buffer.$ptr = array.buffer.$ptr || {};
    // Pointers of different primitive types are non-comparable and stored in different caches.
    var typeCache = cache[array.name] = cache[array.name] || {};
    var cacheIdx = array.BYTES_PER_ELEMENT * index + array.byteOffset;
    return typeCache[cacheIdx] || (typeCache[cacheIdx] = new constructor(function() { return array[index]; }, function(v) { array[index] = v; }));
  } else {
    array.$ptr = array.$ptr || {};
    return array.$ptr[index] || (array.$ptr[index] = new constructor(function() { return array[index]; }, function(v) { array[index] = v; }));
  }
};

var $sliceType = function(elem) {
  var typ = elem.slice;
  if (typ === undefined) {
    typ = $newType(12, $kindSlice, "[]" + elem.string, false, "", false, null);
    elem.slice = typ;
    typ.init(elem);
  }
  return typ;
};
var $makeSlice = function(typ, length, capacity) {
  capacity = capacity || length;
  if (length < 0 || length > 2147483647) {
    $throwRuntimeError("makeslice: len out of range");
  }
  if (capacity < 0 || capacity < length || capacity > 2147483647) {
    $throwRuntimeError("makeslice: cap out of range");
  }
  var array = new typ.nativeArray(capacity);
  if (typ.nativeArray === Array) {
    for (var i = 0; i < capacity; i++) {
      array[i] = typ.elem.zero();
    }
  }
  var slice = new typ(array);
  slice.$length = length;
  return slice;
};

var $structTypes = {};
var $structType = function(pkgPath, fields) {
  var typeKey = $mapArray(fields, function(f) { return f.name + "," + f.typ.id + "," + f.tag; }).join("$");
  var typ = $structTypes[typeKey];
  if (typ === undefined) {
    var string = "struct { " + $mapArray(fields, function(f) {
      var str = f.typ.string + (f.tag !== "" ? (" \"" + f.tag.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"") : "");
      if (f.embedded) {
        return str;
      }
      return f.name + " " + str;
    }).join("; ") + " }";
    if (fields.length === 0) {
      string = "struct {}";
    }
    typ = $newType(0, $kindStruct, string, false, "", false, function() {
      this.$val = this;
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.name == '_') {
          continue;
        }
        var arg = arguments[i];
        this[f.prop] = arg !== undefined ? arg : f.typ.zero();
      }
    });
    $structTypes[typeKey] = typ;
    typ.init(pkgPath, fields);
  }
  return typ;
};

var $assertType = function(value, type, returnTuple) {
  var isInterface = (type.kind === $kindInterface), ok, missingMethod = "";
  if (value === $ifaceNil) {
    ok = false;
  } else if (!isInterface) {
    ok = value.constructor === type;
  } else {
    var valueTypeString = value.constructor.string;
    ok = type.implementedBy[valueTypeString];
    if (ok === undefined) {
      ok = true;
      var valueMethodSet = $methodSet(value.constructor);
      var interfaceMethods = type.methods;
      for (var i = 0; i < interfaceMethods.length; i++) {
        var tm = interfaceMethods[i];
        var found = false;
        for (var j = 0; j < valueMethodSet.length; j++) {
          var vm = valueMethodSet[j];
          if (vm.name === tm.name && vm.pkg === tm.pkg && vm.typ === tm.typ) {
            found = true;
            break;
          }
        }
        if (!found) {
          ok = false;
          type.missingMethodFor[valueTypeString] = tm.name;
          break;
        }
      }
      type.implementedBy[valueTypeString] = ok;
    }
    if (!ok) {
      missingMethod = type.missingMethodFor[valueTypeString];
    }
  }

  if (!ok) {
    if (returnTuple) {
      return [type.zero(), false];
    }
    $panic(new $packages["runtime"].TypeAssertionError.ptr(
      $packages["runtime"]._type.ptr.nil,
      (value === $ifaceNil ? $packages["runtime"]._type.ptr.nil : new $packages["runtime"]._type.ptr(value.constructor.string)),
      new $packages["runtime"]._type.ptr(type.string),
      missingMethod));
  }

  if (!isInterface) {
    value = value.$val;
  }
  if (type === $jsObjectPtr) {
    value = value.object;
  }
  return returnTuple ? [value, true] : value;
};

var $stackDepthOffset = 0;
var $getStackDepth = function() {
  var err = new Error();
  if (err.stack === undefined) {
    return undefined;
  }
  return $stackDepthOffset + err.stack.split("\n").length;
};

var $panicStackDepth = null, $panicValue;
var $callDeferred = function(deferred, jsErr, fromPanic) {
  if (!fromPanic && deferred !== null && $curGoroutine.deferStack.indexOf(deferred) == -1) {
    throw jsErr;
  }
  if (jsErr !== null) {
    var newErr = null;
    try {
      $panic(new $jsErrorPtr(jsErr));
    } catch (err) {
      newErr = err;
    }
    $callDeferred(deferred, newErr);
    return;
  }
  if ($curGoroutine.asleep) {
    return;
  }

  $stackDepthOffset--;
  var outerPanicStackDepth = $panicStackDepth;
  var outerPanicValue = $panicValue;

  var localPanicValue = $curGoroutine.panicStack.pop();
  if (localPanicValue !== undefined) {
    $panicStackDepth = $getStackDepth();
    $panicValue = localPanicValue;
  }

  try {
    while (true) {
      if (deferred === null) {
        deferred = $curGoroutine.deferStack[$curGoroutine.deferStack.length - 1];
        if (deferred === undefined) {
          /* The panic reached the top of the stack. Clear it and throw it as a JavaScript error. */
          $panicStackDepth = null;
          if (localPanicValue.Object instanceof Error) {
            throw localPanicValue.Object;
          }
          var msg;
          if (localPanicValue.constructor === $String) {
            msg = localPanicValue.$val;
          } else if (localPanicValue.Error !== undefined) {
            msg = localPanicValue.Error();
          } else if (localPanicValue.String !== undefined) {
            msg = localPanicValue.String();
          } else {
            msg = localPanicValue;
          }
          throw new Error(msg);
        }
      }
      var call = deferred.pop();
      if (call === undefined) {
        $curGoroutine.deferStack.pop();
        if (localPanicValue !== undefined) {
          deferred = null;
          continue;
        }
        return;
      }
      var r = call[0].apply(call[2], call[1]);
      if (r && r.$blk !== undefined) {
        deferred.push([r.$blk, [], r]);
        if (fromPanic) {
          throw null;
        }
        return;
      }

      if (localPanicValue !== undefined && $panicStackDepth === null) {
        /* error was recovered */
        if (fromPanic) {
          throw null;
        }
        return;
      }
    }
  } catch(e) {
    // Deferred function threw a JavaScript exception or tries to unwind stack
    // to the point where a panic was handled.
    if (fromPanic) {
      // Re-throw the exception to reach deferral execution call at the end
      // of the function.
      throw e;
    }
    // We are at the end of the function, handle the error or re-throw to
    // continue unwinding if necessary, or simply stop unwinding if we got far
    // enough.
    $callDeferred(deferred, e, fromPanic);
  } finally {
    if (localPanicValue !== undefined) {
      if ($panicStackDepth !== null) {
        $curGoroutine.panicStack.push(localPanicValue);
      }
      $panicStackDepth = outerPanicStackDepth;
      $panicValue = outerPanicValue;
    }
    $stackDepthOffset++;
  }
};

var $panic = function(value) {
  $curGoroutine.panicStack.push(value);
  $callDeferred(null, null, true);
};
var $recover = function() {
  if ($panicStackDepth === null || ($panicStackDepth !== undefined && $panicStackDepth !== $getStackDepth() - 2)) {
    return $ifaceNil;
  }
  $panicStackDepth = null;
  return $panicValue;
};
var $throw = function(err) { throw err; };

var $noGoroutine = { asleep: false, exit: false, deferStack: [], panicStack: [] };
var $curGoroutine = $noGoroutine, $totalGoroutines = 0, $awakeGoroutines = 0, $checkForDeadlock = true, $exportedFunctions = 0;
var $mainFinished = false;
var $go = function(fun, args) {
  $totalGoroutines++;
  $awakeGoroutines++;
  var $goroutine = function() {
    try {
      $curGoroutine = $goroutine;
      var r = fun.apply(undefined, args);
      if (r && r.$blk !== undefined) {
        fun = function() { return r.$blk(); };
        args = [];
        return;
      }
      $goroutine.exit = true;
    } catch (err) {
      if (!$goroutine.exit) {
        throw err;
      }
    } finally {
      $curGoroutine = $noGoroutine;
      if ($goroutine.exit) { /* also set by runtime.Goexit() */
        $totalGoroutines--;
        $goroutine.asleep = true;
      }
      if ($goroutine.asleep) {
        $awakeGoroutines--;
        if (!$mainFinished && $awakeGoroutines === 0 && $checkForDeadlock && $exportedFunctions === 0) {
          console.error("fatal error: all goroutines are asleep - deadlock!");
          if ($global.process !== undefined) {
            $global.process.exit(2);
          }
        }
      }
    }
  };
  $goroutine.asleep = false;
  $goroutine.exit = false;
  $goroutine.deferStack = [];
  $goroutine.panicStack = [];
  $schedule($goroutine);
};

var $scheduled = [];
var $runScheduled = function() {
  // For nested setTimeout calls browsers enforce 4ms minimum delay. We minimize
  // the effect of this penalty by queueing the timer preemptively before we run
  // the goroutines, and later cancelling it if it turns out unneeded. See:
  // https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#nested_timeouts
  var nextRun = setTimeout($runScheduled);
  try {
    var start = Date.now();
    var r;
    while ((r = $scheduled.shift()) !== undefined) {
      r();
      // We need to interrupt this loop in order to allow the event loop to
      // process timers, IO, etc. However, invoking scheduling through
      // setTimeout is ~1000 times more expensive, so we amortize this cost by
      // looping until the 4ms minimal delay has elapsed (assuming there are
      // scheduled goroutines to run), and then yield to the event loop.
      var elapsed = Date.now() - start;
      if (elapsed > 4 || elapsed < 0) { break; }
    }
  } finally {
    if ($scheduled.length == 0) {
      // Cancel scheduling pass if there's nothing to run.
      clearTimeout(nextRun);
    }
  }
};

var $schedule = function(goroutine) {
  if (goroutine.asleep) {
    goroutine.asleep = false;
    $awakeGoroutines++;
  }
  $scheduled.push(goroutine);
  if ($curGoroutine === $noGoroutine) {
    $runScheduled();
  }
};

var $setTimeout = function(f, t) {
  $awakeGoroutines++;
  return setTimeout(function() {
    $awakeGoroutines--;
    f();
  }, t);
};

var $block = function() {
  if ($curGoroutine === $noGoroutine) {
    $throwRuntimeError("cannot block in JavaScript callback, fix by wrapping code in goroutine");
  }
  $curGoroutine.asleep = true;
};

var $restore = function(context, params) {
  if (context !== undefined && context.$blk !== undefined) {
    return context;
  }
  return params;
}

var $send = function(chan, value) {
  if (chan.$closed) {
    $throwRuntimeError("send on closed channel");
  }
  var queuedRecv = chan.$recvQueue.shift();
  if (queuedRecv !== undefined) {
    queuedRecv([value, true]);
    return;
  }
  if (chan.$buffer.length < chan.$capacity) {
    chan.$buffer.push(value);
    return;
  }

  var thisGoroutine = $curGoroutine;
  var closedDuringSend;
  chan.$sendQueue.push(function(closed) {
    closedDuringSend = closed;
    $schedule(thisGoroutine);
    return value;
  });
  $block();
  return {
    $blk: function() {
      if (closedDuringSend) {
        $throwRuntimeError("send on closed channel");
      }
    }
  };
};
var $recv = function(chan) {
  var queuedSend = chan.$sendQueue.shift();
  if (queuedSend !== undefined) {
    chan.$buffer.push(queuedSend(false));
  }
  var bufferedValue = chan.$buffer.shift();
  if (bufferedValue !== undefined) {
    return [bufferedValue, true];
  }
  if (chan.$closed) {
    return [chan.$elem.zero(), false];
  }

  var thisGoroutine = $curGoroutine;
  var f = { $blk: function() { return this.value; } };
  var queueEntry = function(v) {
    f.value = v;
    $schedule(thisGoroutine);
  };
  chan.$recvQueue.push(queueEntry);
  $block();
  return f;
};
var $close = function(chan) {
  if (chan.$closed) {
    $throwRuntimeError("close of closed channel");
  }
  chan.$closed = true;
  while (true) {
    var queuedSend = chan.$sendQueue.shift();
    if (queuedSend === undefined) {
      break;
    }
    queuedSend(true); /* will panic */
  }
  while (true) {
    var queuedRecv = chan.$recvQueue.shift();
    if (queuedRecv === undefined) {
      break;
    }
    queuedRecv([chan.$elem.zero(), false]);
  }
};
var $select = function(comms) {
  var ready = [];
  var selection = -1;
  for (var i = 0; i < comms.length; i++) {
    var comm = comms[i];
    var chan = comm[0];
    switch (comm.length) {
    case 0: /* default */
      selection = i;
      break;
    case 1: /* recv */
      if (chan.$sendQueue.length !== 0 || chan.$buffer.length !== 0 || chan.$closed) {
        ready.push(i);
      }
      break;
    case 2: /* send */
      if (chan.$closed) {
        $throwRuntimeError("send on closed channel");
      }
      if (chan.$recvQueue.length !== 0 || chan.$buffer.length < chan.$capacity) {
        ready.push(i);
      }
      break;
    }
  }

  if (ready.length !== 0) {
    selection = ready[Math.floor(Math.random() * ready.length)];
  }
  if (selection !== -1) {
    var comm = comms[selection];
    switch (comm.length) {
    case 0: /* default */
      return [selection];
    case 1: /* recv */
      return [selection, $recv(comm[0])];
    case 2: /* send */
      $send(comm[0], comm[1]);
      return [selection];
    }
  }

  var entries = [];
  var thisGoroutine = $curGoroutine;
  var f = { $blk: function() { return this.selection; } };
  var removeFromQueues = function() {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var queue = entry[0];
      var index = queue.indexOf(entry[1]);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }
  };
  for (var i = 0; i < comms.length; i++) {
    (function(i) {
      var comm = comms[i];
      switch (comm.length) {
      case 1: /* recv */
        var queueEntry = function(value) {
          f.selection = [i, value];
          removeFromQueues();
          $schedule(thisGoroutine);
        };
        entries.push([comm[0].$recvQueue, queueEntry]);
        comm[0].$recvQueue.push(queueEntry);
        break;
      case 2: /* send */
        var queueEntry = function() {
          if (comm[0].$closed) {
            $throwRuntimeError("send on closed channel");
          }
          f.selection = [i];
          removeFromQueues();
          $schedule(thisGoroutine);
          return comm[1];
        };
        entries.push([comm[0].$sendQueue, queueEntry]);
        comm[0].$sendQueue.push(queueEntry);
        break;
      }
    })(i);
  }
  $block();
  return f;
};

var $jsObjectPtr, $jsErrorPtr;

var $needsExternalization = function(t) {
  switch (t.kind) {
    case $kindBool:
    case $kindInt:
    case $kindInt8:
    case $kindInt16:
    case $kindInt32:
    case $kindUint:
    case $kindUint8:
    case $kindUint16:
    case $kindUint32:
    case $kindUintptr:
    case $kindFloat32:
    case $kindFloat64:
      return false;
    default:
      return t !== $jsObjectPtr;
  }
};

var $externalize = function(v, t, makeWrapper) {
  if (t === $jsObjectPtr) {
    return v;
  }
  switch (t.kind) {
  case $kindBool:
  case $kindInt:
  case $kindInt8:
  case $kindInt16:
  case $kindInt32:
  case $kindUint:
  case $kindUint8:
  case $kindUint16:
  case $kindUint32:
  case $kindUintptr:
  case $kindFloat32:
  case $kindFloat64:
    return v;
  case $kindInt64:
  case $kindUint64:
    return $flatten64(v);
  case $kindArray:
    if ($needsExternalization(t.elem)) {
      return $mapArray(v, function(e) { return $externalize(e, t.elem, makeWrapper); });
    }
    return v;
  case $kindFunc:
    return $externalizeFunction(v, t, false, makeWrapper);
  case $kindInterface:
    if (v === $ifaceNil) {
      return null;
    }
    if (v.constructor === $jsObjectPtr) {
      return v.$val.object;
    }
    return $externalize(v.$val, v.constructor, makeWrapper);
  case $kindMap:
    var m = {};
    var keys = $keys(v);
    for (var i = 0; i < keys.length; i++) {
      var entry = v[keys[i]];
      m[$externalize(entry.k, t.key, makeWrapper)] = $externalize(entry.v, t.elem, makeWrapper);
    }
    return m;
  case $kindPtr:
    if (v === t.nil) {
      return null;
    }
    return $externalize(v.$get(), t.elem, makeWrapper);
  case $kindSlice:
    if ($needsExternalization(t.elem)) {
      return $mapArray($sliceToNativeArray(v), function(e) { return $externalize(e, t.elem, makeWrapper); });
    }
    return $sliceToNativeArray(v);
  case $kindString:
    if ($isASCII(v)) {
      return v;
    }
    var s = "", r;
    for (var i = 0; i < v.length; i += r[1]) {
      r = $decodeRune(v, i);
      var c = r[0];
      if (c > 0xFFFF) {
        var h = Math.floor((c - 0x10000) / 0x400) + 0xD800;
        var l = (c - 0x10000) % 0x400 + 0xDC00;
        s += String.fromCharCode(h, l);
        continue;
      }
      s += String.fromCharCode(c);
    }
    return s;
  case $kindStruct:
    var timePkg = $packages["time"];
    if (timePkg !== undefined && v.constructor === timePkg.Time.ptr) {
      var milli = $div64(v.UnixNano(), new $Int64(0, 1000000));
      return new Date($flatten64(milli));
    }

    var noJsObject = {};
    var searchJsObject = function(v, t) {
      if (t === $jsObjectPtr) {
        return v;
      }
      switch (t.kind) {
      case $kindPtr:
        if (v === t.nil) {
          return noJsObject;
        }
        return searchJsObject(v.$get(), t.elem);
      case $kindStruct:
        var f = t.fields[0];
        return searchJsObject(v[f.prop], f.typ);
      case $kindInterface:
        return searchJsObject(v.$val, v.constructor);
      default:
        return noJsObject;
      }
    };
    var o = searchJsObject(v, t);
    if (o !== noJsObject) {
      return o;
    }

    if (makeWrapper !== undefined) {
      return makeWrapper(v);
    }

    o = {};
    for (var i = 0; i < t.fields.length; i++) {
      var f = t.fields[i];
      if (!f.exported) {
        continue;
      }
      o[f.name] = $externalize(v[f.prop], f.typ, makeWrapper);
    }
    return o;
  }
  $throwRuntimeError("cannot externalize " + t.string);
};

var $externalizeFunction = function(v, t, passThis, makeWrapper) {
  if (v === $throwNilPointerError) {
    return null;
  }
  if (v.$externalizeWrapper === undefined) {
    $checkForDeadlock = false;
    v.$externalizeWrapper = function() {
      var args = [];
      for (var i = 0; i < t.params.length; i++) {
        if (t.variadic && i === t.params.length - 1) {
          var vt = t.params[i].elem, varargs = [];
          for (var j = i; j < arguments.length; j++) {
            varargs.push($internalize(arguments[j], vt, makeWrapper));
          }
          args.push(new (t.params[i])(varargs));
          break;
        }
        args.push($internalize(arguments[i], t.params[i], makeWrapper));
      }
      var result = v.apply(passThis ? this : undefined, args);
      switch (t.results.length) {
      case 0:
        return;
      case 1:
        return $externalize($copyIfRequired(result, t.results[0]), t.results[0], makeWrapper);
      default:
        for (var i = 0; i < t.results.length; i++) {
          result[i] = $externalize($copyIfRequired(result[i], t.results[i]), t.results[i], makeWrapper);
        }
        return result;
      }
    };
  }
  return v.$externalizeWrapper;
};

var $internalize = function(v, t, recv, seen, makeWrapper) {
  if (t === $jsObjectPtr) {
    return v;
  }
  if (t === $jsObjectPtr.elem) {
    $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
  }
  if (v && v.__internal_object__ !== undefined) {
    return $assertType(v.__internal_object__, t, false);
  }
  var timePkg = $packages["time"];
  if (timePkg !== undefined && t === timePkg.Time) {
    if (!(v !== null && v !== undefined && v.constructor === Date)) {
      $throwRuntimeError("cannot internalize time.Time from " + typeof v + ", must be Date");
    }
    return timePkg.Unix(new $Int64(0, 0), new $Int64(0, v.getTime() * 1000000));
  }

  // Cache for values we've already internalized in order to deal with circular
  // references.
  if (seen === undefined) { seen = new Map(); }
  if (!seen.has(t)) { seen.set(t, new Map()); }
  if (seen.get(t).has(v)) { return seen.get(t).get(v); }

  switch (t.kind) {
  case $kindBool:
    return !!v;
  case $kindInt:
    return parseInt(v);
  case $kindInt8:
    return parseInt(v) << 24 >> 24;
  case $kindInt16:
    return parseInt(v) << 16 >> 16;
  case $kindInt32:
    return parseInt(v) >> 0;
  case $kindUint:
    return parseInt(v);
  case $kindUint8:
    return parseInt(v) << 24 >>> 24;
  case $kindUint16:
    return parseInt(v) << 16 >>> 16;
  case $kindUint32:
  case $kindUintptr:
    return parseInt(v) >>> 0;
  case $kindInt64:
  case $kindUint64:
    return new t(0, v);
  case $kindFloat32:
  case $kindFloat64:
    return parseFloat(v);
  case $kindArray:
    if (v.length !== t.len) {
      $throwRuntimeError("got array with wrong size from JavaScript native");
    }
    return $mapArray(v, function(e) { return $internalize(e, t.elem, makeWrapper); });
  case $kindFunc:
    return function() {
      var args = [];
      for (var i = 0; i < t.params.length; i++) {
        if (t.variadic && i === t.params.length - 1) {
          var vt = t.params[i].elem, varargs = arguments[i];
          for (var j = 0; j < varargs.$length; j++) {
            args.push($externalize(varargs.$array[varargs.$offset + j], vt, makeWrapper));
          }
          break;
        }
        args.push($externalize(arguments[i], t.params[i], makeWrapper));
      }
      var result = v.apply(recv, args);
      switch (t.results.length) {
      case 0:
        return;
      case 1:
        return $internalize(result, t.results[0], makeWrapper);
      default:
        for (var i = 0; i < t.results.length; i++) {
          result[i] = $internalize(result[i], t.results[i], makeWrapper);
        }
        return result;
      }
    };
  case $kindInterface:
    if (t.methods.length !== 0) {
      $throwRuntimeError("cannot internalize " + t.string);
    }
    if (v === null) {
      return $ifaceNil;
    }
    if (v === undefined) {
      return new $jsObjectPtr(undefined);
    }
    switch (v.constructor) {
    case Int8Array:
      return new ($sliceType($Int8))(v);
    case Int16Array:
      return new ($sliceType($Int16))(v);
    case Int32Array:
      return new ($sliceType($Int))(v);
    case Uint8Array:
      return new ($sliceType($Uint8))(v);
    case Uint16Array:
      return new ($sliceType($Uint16))(v);
    case Uint32Array:
      return new ($sliceType($Uint))(v);
    case Float32Array:
      return new ($sliceType($Float32))(v);
    case Float64Array:
      return new ($sliceType($Float64))(v);
    case Array:
      return $internalize(v, $sliceType($emptyInterface), makeWrapper);
    case Boolean:
      return new $Bool(!!v);
    case Date:
      if (timePkg === undefined) {
        /* time package is not present, internalize as &js.Object{Date} so it can be externalized into original Date. */
        return new $jsObjectPtr(v);
      }
      return new timePkg.Time($internalize(v, timePkg.Time, makeWrapper));
    case (function () { }).constructor: // is usually Function, but in Chrome extensions it is something else
      var funcType = $funcType([$sliceType($emptyInterface)], [$jsObjectPtr], true);
      return new funcType($internalize(v, funcType, makeWrapper));
    case Number:
      return new $Float64(parseFloat(v));
    case String:
      return new $String($internalize(v, $String, makeWrapper));
    default:
      if ($global.Node && v instanceof $global.Node) {
        return new $jsObjectPtr(v);
      }
      var mapType = $mapType($String, $emptyInterface);
      return new mapType($internalize(v, mapType, recv, seen, makeWrapper));
    }
  case $kindMap:
    var m = {};
    seen.get(t).set(v, m);
    var keys = $keys(v);
    for (var i = 0; i < keys.length; i++) {
      var k = $internalize(keys[i], t.key, recv, seen, makeWrapper);
      m[t.key.keyFor(k)] = { k: k, v: $internalize(v[keys[i]], t.elem, recv, seen, makeWrapper) };
    }
    return m;
  case $kindPtr:
    if (t.elem.kind === $kindStruct) {
      return $internalize(v, t.elem, makeWrapper);
    }
  case $kindSlice:
    return new t($mapArray(v, function(e) { return $internalize(e, t.elem, makeWrapper); }));
  case $kindString:
    v = String(v);
    if ($isASCII(v)) {
      return v;
    }
    var s = "";
    var i = 0;
    while (i < v.length) {
      var h = v.charCodeAt(i);
      if (0xD800 <= h && h <= 0xDBFF) {
        var l = v.charCodeAt(i + 1);
        var c = (h - 0xD800) * 0x400 + l - 0xDC00 + 0x10000;
        s += $encodeRune(c);
        i += 2;
        continue;
      }
      s += $encodeRune(h);
      i++;
    }
    return s;
  case $kindStruct:
    var noJsObject = {};
    var searchJsObject = function(t) {
      if (t === $jsObjectPtr) {
        return v;
      }
      if (t === $jsObjectPtr.elem) {
        $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
      }
      switch (t.kind) {
      case $kindPtr:
        return searchJsObject(t.elem);
      case $kindStruct:
        var f = t.fields[0];
        var o = searchJsObject(f.typ);
        if (o !== noJsObject) {
          var n = new t.ptr();
          n[f.prop] = o;
          return n;
        }
        return noJsObject;
      default:
        return noJsObject;
      }
    };
    var o = searchJsObject(t);
    if (o !== noJsObject) {
      return o;
    }
  }
  $throwRuntimeError("cannot internalize " + t.string);
};

var $copyIfRequired = function(v, typ) {
  // interface values
  if (v && v.constructor && v.constructor.copy) {
    return new v.constructor($clone(v.$val, v.constructor))
  }
  // array and struct values
  if (typ.copy) {
    var clone = typ.zero();
    typ.copy(clone, v);
    return clone;
  }
  return v;
}

/* $isASCII reports whether string s contains only ASCII characters. */
var $isASCII = function(s) {
  for (var i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 128) {
      return false;
    }
  }
  return true;
};

$packages["github.com/gopherjs/gopherjs/js"] = (function() {
	var $pkg = {}, $init, Object, Error, M, sliceType, ptrType, sliceType$2, funcType, funcType$1, funcType$2, ptrType$1, MakeWrapper, MakeFullWrapper, init;
	Object = $pkg.Object = $newType(0, $kindStruct, "js.Object", true, "github.com/gopherjs/gopherjs/js", true, function(object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.object = null;
			return;
		}
		this.object = object_;
	});
	Error = $pkg.Error = $newType(0, $kindStruct, "js.Error", true, "github.com/gopherjs/gopherjs/js", true, function(Object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Object = null;
			return;
		}
		this.Object = Object_;
	});
	M = $pkg.M = $newType(4, $kindMap, "js.M", true, "github.com/gopherjs/gopherjs/js", true, null);
	sliceType = $sliceType($emptyInterface);
	ptrType = $ptrType(Object);
	sliceType$2 = $sliceType(ptrType);
	funcType = $funcType([sliceType$2], [ptrType], true);
	funcType$1 = $funcType([], [ptrType], false);
	funcType$2 = $funcType([ptrType], [], false);
	ptrType$1 = $ptrType(Error);
	Object.ptr.prototype.Get = function(key) {
		var key, o;
		o = this;
		return o.object[$externalize(key, $String)];
	};
	Object.prototype.Get = function(key) { return this.$val.Get(key); };
	Object.ptr.prototype.Set = function(key, value) {
		var key, o, value;
		o = this;
		o.object[$externalize(key, $String)] = $externalize(value, $emptyInterface);
	};
	Object.prototype.Set = function(key, value) { return this.$val.Set(key, value); };
	Object.ptr.prototype.Delete = function(key) {
		var key, o;
		o = this;
		delete o.object[$externalize(key, $String)];
	};
	Object.prototype.Delete = function(key) { return this.$val.Delete(key); };
	Object.ptr.prototype.Length = function() {
		var o;
		o = this;
		return $parseInt(o.object.length);
	};
	Object.prototype.Length = function() { return this.$val.Length(); };
	Object.ptr.prototype.Index = function(i) {
		var i, o;
		o = this;
		return o.object[i];
	};
	Object.prototype.Index = function(i) { return this.$val.Index(i); };
	Object.ptr.prototype.SetIndex = function(i, value) {
		var i, o, value;
		o = this;
		o.object[i] = $externalize(value, $emptyInterface);
	};
	Object.prototype.SetIndex = function(i, value) { return this.$val.SetIndex(i, value); };
	Object.ptr.prototype.Call = function(name, args) {
		var args, name, o, obj;
		o = this;
		return (obj = o.object, obj[$externalize(name, $String)].apply(obj, $externalize(args, sliceType)));
	};
	Object.prototype.Call = function(name, args) { return this.$val.Call(name, args); };
	Object.ptr.prototype.Invoke = function(args) {
		var args, o;
		o = this;
		return o.object.apply(undefined, $externalize(args, sliceType));
	};
	Object.prototype.Invoke = function(args) { return this.$val.Invoke(args); };
	Object.ptr.prototype.New = function(args) {
		var args, o;
		o = this;
		return new ($global.Function.prototype.bind.apply(o.object, [undefined].concat($externalize(args, sliceType))));
	};
	Object.prototype.New = function(args) { return this.$val.New(args); };
	Object.ptr.prototype.Bool = function() {
		var o;
		o = this;
		return !!(o.object);
	};
	Object.prototype.Bool = function() { return this.$val.Bool(); };
	Object.ptr.prototype.String = function() {
		var o;
		o = this;
		return $internalize(o.object, $String);
	};
	Object.prototype.String = function() { return this.$val.String(); };
	Object.ptr.prototype.Int = function() {
		var o;
		o = this;
		return $parseInt(o.object) >> 0;
	};
	Object.prototype.Int = function() { return this.$val.Int(); };
	Object.ptr.prototype.Int64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Int64);
	};
	Object.prototype.Int64 = function() { return this.$val.Int64(); };
	Object.ptr.prototype.Uint64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Uint64);
	};
	Object.prototype.Uint64 = function() { return this.$val.Uint64(); };
	Object.ptr.prototype.Float = function() {
		var o;
		o = this;
		return $parseFloat(o.object);
	};
	Object.prototype.Float = function() { return this.$val.Float(); };
	Object.ptr.prototype.Interface = function() {
		var o;
		o = this;
		return $internalize(o.object, $emptyInterface);
	};
	Object.prototype.Interface = function() { return this.$val.Interface(); };
	Object.ptr.prototype.Unsafe = function() {
		var o;
		o = this;
		return o.object;
	};
	Object.prototype.Unsafe = function() { return this.$val.Unsafe(); };
	Error.ptr.prototype.Error = function() {
		var err;
		err = this;
		return "JavaScript error: " + $internalize(err.Object.message, $String);
	};
	Error.prototype.Error = function() { return this.$val.Error(); };
	Error.ptr.prototype.Stack = function() {
		var err;
		err = this;
		return $internalize(err.Object.stack, $String);
	};
	Error.prototype.Stack = function() { return this.$val.Stack(); };
	MakeWrapper = function(i) {
		var i, i$1, m, methods, o, v;
		v = i;
		o = new ($global.Object)();
		o.__internal_object__ = v;
		methods = v.constructor.methods;
		i$1 = 0;
		while (true) {
			if (!(i$1 < $parseInt(methods.length))) { break; }
			m = [m];
			m[0] = methods[i$1];
			if (!($internalize(m[0].pkg, $String) === "")) {
				i$1 = i$1 + (1) >> 0;
				continue;
			}
			o[$externalize($internalize(m[0].name, $String), $String)] = $externalize((function(m) { return function(args) {
				var args;
				return $externalizeFunction(v[$externalize($internalize(m[0].prop, $String), $String)], m[0].typ, $externalize(true, $Bool)).apply(v, $externalize(args, sliceType$2));
			}; })(m), funcType);
			i$1 = i$1 + (1) >> 0;
		}
		return o;
	};
	$pkg.MakeWrapper = MakeWrapper;
	MakeFullWrapper = function(i) {
		var {constructor, defineProperty, e, f, fields, i, i$1, i$2, i$3, internalObj, m, methods, ms, pkg, pkgTyp, ptr, typ, wrapperObj, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		internalObj = [internalObj];
		wrapperObj = [wrapperObj];
		internalObj[0] = i;
		constructor = internalObj[0].constructor;
		wrapperObj[0] = new ($global.Object)();
		defineProperty = (function(internalObj, wrapperObj) { return function(key, descriptor) {
			var descriptor, key;
			$global.Object.defineProperty(wrapperObj[0], $externalize(key, $String), $externalize(descriptor, M));
		}; })(internalObj, wrapperObj);
		$r = defineProperty("__internal_object__", $makeMap($String.keyFor, [{ k: "value", v: new $jsObjectPtr(internalObj[0]) }])); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		typ = $internalize(constructor.string, $String);
		pkg = $internalize(constructor.pkg, $String);
		ptr = "";
		if (typ.charCodeAt(0) === 42) {
			ptr = "*";
		}
		i$1 = 0;
		while (true) {
			if (!(i$1 < typ.length)) { break; }
			if (typ.charCodeAt(i$1) === 46) {
				typ = $substring(typ, (i$1 + 1 >> 0));
				break;
			}
			i$1 = i$1 + (1) >> 0;
		}
		pkgTyp = pkg + "." + ptr + typ;
		$r = defineProperty("$type", $makeMap($String.keyFor, [{ k: "value", v: new $String(pkgTyp) }])); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		fields = null;
		methods = new ($global.Array)();
		ms = constructor.methods;
		if (!(ms === undefined)) {
			methods = methods.concat(ms);
		}
		e = constructor.elem;
		if (!(e === undefined)) {
			fields = e.fields;
			methods = methods.concat(e.methods);
		} else {
			fields = constructor.fields;
		}
		i$2 = 0;
		/* while (true) { */ case 3:
			/* if (!(i$2 < $parseInt(methods.length))) { break; } */ if(!(i$2 < $parseInt(methods.length))) { $s = 4; continue; }
			m = [m];
			m[0] = methods[i$2];
			if (!($internalize(m[0].pkg, $String) === "")) {
				i$2 = i$2 + (1) >> 0;
				/* continue; */ $s = 3; continue;
			}
			$r = defineProperty($internalize(m[0].prop, $String), $makeMap($String.keyFor, [{ k: "value", v: new funcType((function(internalObj, m, wrapperObj) { return function(args) {
				var args;
				return $externalizeFunction(internalObj[0][$externalize($internalize(m[0].prop, $String), $String)], m[0].typ, $externalize(true, $Bool), MakeFullWrapper).apply(internalObj[0], $externalize(args, sliceType$2));
			}; })(internalObj, m, wrapperObj)) }])); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i$2 = i$2 + (1) >> 0;
		$s = 3; continue;
		case 4:
		/* */ if (!(fields === undefined)) { $s = 6; continue; }
		/* */ $s = 7; continue;
		/* if (!(fields === undefined)) { */ case 6:
			i$3 = 0;
			/* while (true) { */ case 8:
				/* if (!(i$3 < $parseInt(fields.length))) { break; } */ if(!(i$3 < $parseInt(fields.length))) { $s = 9; continue; }
				f = [f];
				f[0] = fields[i$3];
				if (!!!(f[0].exported)) {
					i$3 = i$3 + (1) >> 0;
					/* continue; */ $s = 8; continue;
				}
				$r = defineProperty($internalize(f[0].prop, $String), $makeMap($String.keyFor, [{ k: "get", v: new funcType$1((function(f, internalObj, wrapperObj) { return function() {
					var vc;
					vc = $copyIfRequired(internalObj[0].$val[$externalize($internalize(f[0].prop, $String), $String)], f[0].typ);
					return $externalize(vc, f[0].typ, MakeFullWrapper);
				}; })(f, internalObj, wrapperObj)) }, { k: "set", v: new funcType$2((function(f, internalObj, wrapperObj) { return function(jv) {
					var gv, jv;
					gv = $internalize(jv, f[0].typ, MakeFullWrapper);
					internalObj[0].$val[$externalize($internalize(f[0].prop, $String), $String)] = gv;
				}; })(f, internalObj, wrapperObj)) }])); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				i$3 = i$3 + (1) >> 0;
			$s = 8; continue;
			case 9:
		/* } */ case 7:
		$s = -1; return wrapperObj[0];
		/* */ } return; } var $f = {$blk: MakeFullWrapper, $c: true, $r, constructor, defineProperty, e, f, fields, i, i$1, i$2, i$3, internalObj, m, methods, ms, pkg, pkgTyp, ptr, typ, wrapperObj, $s};return $f;
	};
	$pkg.MakeFullWrapper = MakeFullWrapper;
	init = function() {
		var e;
		e = new Error.ptr(null);
		$unused(e);
	};
	ptrType.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [ptrType], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Length", name: "Length", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [ptrType], false)}, {prop: "SetIndex", name: "SetIndex", pkg: "", typ: $funcType([$Int, $emptyInterface], [], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType], [ptrType], true)}, {prop: "Invoke", name: "Invoke", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "New", name: "New", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Int64", name: "Int64", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "Uint64", name: "Uint64", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Interface", name: "Interface", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "Unsafe", name: "Unsafe", pkg: "", typ: $funcType([], [$Uintptr], false)}];
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Stack", name: "Stack", pkg: "", typ: $funcType([], [$String], false)}];
	Object.init("github.com/gopherjs/gopherjs/js", [{prop: "object", name: "object", embedded: false, exported: false, typ: ptrType, tag: ""}]);
	Error.init("", [{prop: "Object", name: "Object", embedded: true, exported: true, typ: ptrType, tag: ""}]);
	M.init($String, $emptyInterface);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["runtime"] = (function() {
	var $pkg = {}, $init, js, _type, TypeAssertionError, errorString, ptrType$1, ptrType$2, buildVersion, init, throw$1;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	_type = $pkg._type = $newType(0, $kindStruct, "runtime._type", true, "runtime", false, function(str_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.str = "";
			return;
		}
		this.str = str_;
	});
	TypeAssertionError = $pkg.TypeAssertionError = $newType(0, $kindStruct, "runtime.TypeAssertionError", true, "runtime", true, function(_interface_, concrete_, asserted_, missingMethod_) {
		this.$val = this;
		if (arguments.length === 0) {
			this._interface = ptrType$1.nil;
			this.concrete = ptrType$1.nil;
			this.asserted = ptrType$1.nil;
			this.missingMethod = "";
			return;
		}
		this._interface = _interface_;
		this.concrete = concrete_;
		this.asserted = asserted_;
		this.missingMethod = missingMethod_;
	});
	errorString = $pkg.errorString = $newType(8, $kindString, "runtime.errorString", true, "runtime", false, null);
	ptrType$1 = $ptrType(_type);
	ptrType$2 = $ptrType(TypeAssertionError);
	_type.ptr.prototype.string = function() {
		var t;
		t = this;
		return t.str;
	};
	_type.prototype.string = function() { return this.$val.string(); };
	_type.ptr.prototype.pkgpath = function() {
		var t;
		t = this;
		return "";
	};
	_type.prototype.pkgpath = function() { return this.$val.pkgpath(); };
	TypeAssertionError.ptr.prototype.RuntimeError = function() {
	};
	TypeAssertionError.prototype.RuntimeError = function() { return this.$val.RuntimeError(); };
	TypeAssertionError.ptr.prototype.Error = function() {
		var as, cs, e, inter, msg;
		e = this;
		inter = "interface";
		if (!(e._interface === ptrType$1.nil)) {
			inter = e._interface.string();
		}
		as = e.asserted.string();
		if (e.concrete === ptrType$1.nil) {
			return "interface conversion: " + inter + " is nil, not " + as;
		}
		cs = e.concrete.string();
		if (e.missingMethod === "") {
			msg = "interface conversion: " + inter + " is " + cs + ", not " + as;
			if (cs === as) {
				if (!(e.concrete.pkgpath() === e.asserted.pkgpath())) {
					msg = msg + (" (types from different packages)");
				} else {
					msg = msg + (" (types from different scopes)");
				}
			}
			return msg;
		}
		return "interface conversion: " + cs + " is not " + as + ": missing method " + e.missingMethod;
	};
	TypeAssertionError.prototype.Error = function() { return this.$val.Error(); };
	init = function() {
		var e, jsPkg;
		jsPkg = $packages[$externalize("github.com/gopherjs/gopherjs/js", $String)];
		$jsObjectPtr = jsPkg.Object.ptr;
		$jsErrorPtr = jsPkg.Error.ptr;
		$throwRuntimeError = throw$1;
		buildVersion = $internalize($goVersion, $String);
		e = $ifaceNil;
		e = new TypeAssertionError.ptr(ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, "");
		$unused(e);
	};
	errorString.prototype.RuntimeError = function() {
		var e;
		e = this.$val;
	};
	$ptrType(errorString).prototype.RuntimeError = function() { return new errorString(this.$get()).RuntimeError(); };
	errorString.prototype.Error = function() {
		var e;
		e = this.$val;
		return "runtime error: " + (e);
	};
	$ptrType(errorString).prototype.Error = function() { return new errorString(this.$get()).Error(); };
	throw$1 = function(s) {
		var s;
		$panic(new errorString((s)));
	};
	ptrType$1.methods = [{prop: "string", name: "string", pkg: "runtime", typ: $funcType([], [$String], false)}, {prop: "pkgpath", name: "pkgpath", pkg: "runtime", typ: $funcType([], [$String], false)}];
	ptrType$2.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	_type.init("runtime", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	TypeAssertionError.init("runtime", [{prop: "_interface", name: "_interface", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "concrete", name: "concrete", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "asserted", name: "asserted", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "missingMethod", name: "missingMethod", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buildVersion = "";
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math/bits"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math"] = (function() {
	var $pkg = {}, $init, js, bits, arrayType, arrayType$1, arrayType$2, structType, math, _zero, posInf, negInf, nan, buf, Round, max, min, Abs, Cos, Floor, Inf, IsInf, IsNaN, Max, Min, NaN, Pow, Signbit, Sin, Sqrt, init, Float64bits, Float64frombits;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	bits = $packages["math/bits"];
	arrayType = $arrayType($Uint32, 2);
	arrayType$1 = $arrayType($Float32, 2);
	arrayType$2 = $arrayType($Float64, 1);
	structType = $structType("math", [{prop: "uint32array", name: "uint32array", embedded: false, exported: false, typ: arrayType, tag: ""}, {prop: "float32array", name: "float32array", embedded: false, exported: false, typ: arrayType$1, tag: ""}, {prop: "float64array", name: "float64array", embedded: false, exported: false, typ: arrayType$2, tag: ""}]);
	Round = function(x) {
		var bits$1, e, x, x$1, x$2, x$3, x$4;
		bits$1 = Float64bits(x);
		e = ((($shiftRightUint64(bits$1, 52).$low >>> 0)) & 2047) >>> 0;
		if (e < 1023) {
			bits$1 = (x$1 = new $Uint64(2147483648, 0), new $Uint64(bits$1.$high & x$1.$high, (bits$1.$low & x$1.$low) >>> 0));
			if (e === 1022) {
				bits$1 = (x$2 = new $Uint64(1072693248, 0), new $Uint64(bits$1.$high | x$2.$high, (bits$1.$low | x$2.$low) >>> 0));
			}
		} else if (e < 1075) {
			e = e - (1023) >>> 0;
			bits$1 = (x$3 = $shiftRightUint64(new $Uint64(524288, 0), e), new $Uint64(bits$1.$high + x$3.$high, bits$1.$low + x$3.$low));
			bits$1 = (x$4 = $shiftRightUint64(new $Uint64(1048575, 4294967295), e), new $Uint64(bits$1.$high & ~x$4.$high, (bits$1.$low & ~x$4.$low) >>> 0));
		}
		return Float64frombits(bits$1);
	};
	$pkg.Round = Round;
	max = function(x, y) {
		var x, y;
		if (IsInf(x, 1) || IsInf(y, 1)) {
			return Inf(1);
		} else if (IsNaN(x) || IsNaN(y)) {
			return NaN();
		} else if ((x === 0) && (x === y)) {
			if (Signbit(x)) {
				return y;
			}
			return x;
		}
		if (x > y) {
			return x;
		}
		return y;
	};
	min = function(x, y) {
		var x, y;
		if (IsInf(x, -1) || IsInf(y, -1)) {
			return Inf(-1);
		} else if (IsNaN(x) || IsNaN(y)) {
			return NaN();
		} else if ((x === 0) && (x === y)) {
			if (Signbit(x)) {
				return x;
			}
			return y;
		}
		if (x < y) {
			return x;
		}
		return y;
	};
	Abs = function(x) {
		var x, x$1;
		return Float64frombits((x$1 = Float64bits(x), new $Uint64(x$1.$high & ~2147483648, (x$1.$low & ~0) >>> 0)));
	};
	$pkg.Abs = Abs;
	Cos = function(x) {
		var x;
		return $parseFloat(math.cos(x));
	};
	$pkg.Cos = Cos;
	Floor = function(x) {
		var x;
		return $parseFloat(math.floor(x));
	};
	$pkg.Floor = Floor;
	Inf = function(sign) {
		var sign;
		if (sign >= 0) {
			return posInf;
		} else {
			return negInf;
		}
	};
	$pkg.Inf = Inf;
	IsInf = function(f, sign) {
		var f, sign;
		if (f === posInf) {
			return sign >= 0;
		}
		if (f === negInf) {
			return sign <= 0;
		}
		return false;
	};
	$pkg.IsInf = IsInf;
	IsNaN = function(f) {
		var f, is;
		is = false;
		is = !((f === f));
		return is;
	};
	$pkg.IsNaN = IsNaN;
	Max = function(x, y) {
		var x, y;
		return max(x, y);
	};
	$pkg.Max = Max;
	Min = function(x, y) {
		var x, y;
		return min(x, y);
	};
	$pkg.Min = Min;
	NaN = function() {
		return nan;
	};
	$pkg.NaN = NaN;
	Pow = function(x, y) {
		var x, y;
		if ((x === 1) || ((x === -1) && ((y === posInf) || (y === negInf)))) {
			return 1;
		}
		return $parseFloat(math.pow(x, y));
	};
	$pkg.Pow = Pow;
	Signbit = function(x) {
		var x;
		return x < 0 || (1 / x === negInf);
	};
	$pkg.Signbit = Signbit;
	Sin = function(x) {
		var x;
		return $parseFloat(math.sin(x));
	};
	$pkg.Sin = Sin;
	Sqrt = function(x) {
		var x;
		return $parseFloat(math.sqrt(x));
	};
	$pkg.Sqrt = Sqrt;
	init = function() {
		var ab;
		ab = new ($global.ArrayBuffer)(8);
		buf.uint32array = new ($global.Uint32Array)(ab);
		buf.float32array = new ($global.Float32Array)(ab);
		buf.float64array = new ($global.Float64Array)(ab);
	};
	Float64bits = function(f) {
		var f, x, x$1;
		buf.float64array[0] = f;
		return (x = $shiftLeft64((new $Uint64(0, buf.uint32array[1])), 32), x$1 = (new $Uint64(0, buf.uint32array[0])), new $Uint64(x.$high + x$1.$high, x.$low + x$1.$low));
	};
	$pkg.Float64bits = Float64bits;
	Float64frombits = function(b) {
		var b;
		buf.uint32array[0] = ((b.$low >>> 0));
		buf.uint32array[1] = (($shiftRightUint64(b, 32).$low >>> 0));
		return buf.float64array[0];
	};
	$pkg.Float64frombits = Float64frombits;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bits.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buf = new structType.ptr(arrayType.zero(), arrayType$1.zero(), arrayType$2.zero());
		math = $global.Math;
		_zero = 0;
		posInf = 1 / _zero;
		negInf = -1 / _zero;
		nan = $parseFloat($NaN);
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["resolv"] = (function() {
	var $pkg = {}, $init, math, Vector, Axis, Space, Shape, Line, ConvexPolygon, ContactSet, Circle, Projection, RingBuffer, Object, Collision, Cell, sliceType, ptrType, sliceType$1, sliceType$2, ptrType$1, ptrType$2, sliceType$3, sliceType$4, ptrType$3, ptrType$4, sliceType$5, ptrType$5, ptrType$6, ptrType$7, sliceType$6, sliceType$7, ptrType$8, sliceType$8, ptrType$9, mapType, Dot, NewSpace, NewLine, NewConvexPolygon, NewContactSet, NewRectangle, NewCircle, NewRingBuffer, NewObjectSingleTag, NewObject, axpyUnitaryTo, scalUnitaryTo, NewCollision, newCell;
	math = $packages["math"];
	Vector = $pkg.Vector = $newType(12, $kindSlice, "resolv.Vector", true, "resolv", true, null);
	Axis = $pkg.Axis = $newType(4, $kindInt, "resolv.Axis", true, "resolv", true, null);
	Space = $pkg.Space = $newType(0, $kindStruct, "resolv.Space", true, "resolv", true, function(Cells_, CellWidth_, CellHeight_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Cells = sliceType$2.nil;
			this.CellWidth = 0;
			this.CellHeight = 0;
			return;
		}
		this.Cells = Cells_;
		this.CellWidth = CellWidth_;
		this.CellHeight = CellHeight_;
	});
	Shape = $pkg.Shape = $newType(8, $kindInterface, "resolv.Shape", true, "resolv", true, null);
	Line = $pkg.Line = $newType(0, $kindStruct, "resolv.Line", true, "resolv", true, function(Start_, End_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Start = Vector.nil;
			this.End = Vector.nil;
			return;
		}
		this.Start = Start_;
		this.End = End_;
	});
	ConvexPolygon = $pkg.ConvexPolygon = $newType(0, $kindStruct, "resolv.ConvexPolygon", true, "resolv", true, function(Points_, X_, Y_, Closed_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Points = ptrType$3.nil;
			this.X = 0;
			this.Y = 0;
			this.Closed = false;
			return;
		}
		this.Points = Points_;
		this.X = X_;
		this.Y = Y_;
		this.Closed = Closed_;
	});
	ContactSet = $pkg.ContactSet = $newType(0, $kindStruct, "resolv.ContactSet", true, "resolv", true, function(Points_, MTV_, Center_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Points = sliceType$4.nil;
			this.MTV = Vector.nil;
			this.Center = Vector.nil;
			return;
		}
		this.Points = Points_;
		this.MTV = MTV_;
		this.Center = Center_;
	});
	Circle = $pkg.Circle = $newType(0, $kindStruct, "resolv.Circle", true, "resolv", true, function(X_, Y_, Radius_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.X = 0;
			this.Y = 0;
			this.Radius = 0;
			return;
		}
		this.X = X_;
		this.Y = Y_;
		this.Radius = Radius_;
	});
	Projection = $pkg.Projection = $newType(0, $kindStruct, "resolv.Projection", true, "resolv", true, function(Min_, Max_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Min = 0;
			this.Max = 0;
			return;
		}
		this.Min = Min_;
		this.Max = Max_;
	});
	RingBuffer = $pkg.RingBuffer = $newType(0, $kindStruct, "resolv.RingBuffer", true, "resolv", true, function(Ed_, St_, EdFrameId_, StFrameId_, N_, Cnt_, Eles_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Ed = 0;
			this.St = 0;
			this.EdFrameId = 0;
			this.StFrameId = 0;
			this.N = 0;
			this.Cnt = 0;
			this.Eles = sliceType$6.nil;
			return;
		}
		this.Ed = Ed_;
		this.St = St_;
		this.EdFrameId = EdFrameId_;
		this.StFrameId = StFrameId_;
		this.N = N_;
		this.Cnt = Cnt_;
		this.Eles = Eles_;
	});
	Object = $pkg.Object = $newType(0, $kindStruct, "resolv.Object", true, "resolv", true, function(Shape_, Space_, X_, Y_, W_, H_, TouchingCells_, Data_, ignoreList_, tags_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Shape = $ifaceNil;
			this.Space = ptrType$1.nil;
			this.X = 0;
			this.Y = 0;
			this.W = 0;
			this.H = 0;
			this.TouchingCells = ptrType$3.nil;
			this.Data = $ifaceNil;
			this.ignoreList = false;
			this.tags = sliceType$7.nil;
			return;
		}
		this.Shape = Shape_;
		this.Space = Space_;
		this.X = X_;
		this.Y = Y_;
		this.W = W_;
		this.H = H_;
		this.TouchingCells = TouchingCells_;
		this.Data = Data_;
		this.ignoreList = ignoreList_;
		this.tags = tags_;
	});
	Collision = $pkg.Collision = $newType(0, $kindStruct, "resolv.Collision", true, "resolv", true, function(checkingObject_, dx_, dy_, Objects_, Cells_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.checkingObject = ptrType$2.nil;
			this.dx = 0;
			this.dy = 0;
			this.Objects = ptrType$3.nil;
			this.Cells = ptrType$3.nil;
			return;
		}
		this.checkingObject = checkingObject_;
		this.dx = dx_;
		this.dy = dy_;
		this.Objects = Objects_;
		this.Cells = Cells_;
	});
	Cell = $pkg.Cell = $newType(0, $kindStruct, "resolv.Cell", true, "resolv", true, function(X_, Y_, Objects_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.X = 0;
			this.Y = 0;
			this.Objects = ptrType$3.nil;
			return;
		}
		this.X = X_;
		this.Y = Y_;
		this.Objects = Objects_;
	});
	sliceType = $sliceType($Float64);
	ptrType = $ptrType(Cell);
	sliceType$1 = $sliceType(ptrType);
	sliceType$2 = $sliceType(sliceType$1);
	ptrType$1 = $ptrType(Space);
	ptrType$2 = $ptrType(Object);
	sliceType$3 = $sliceType(ptrType$2);
	sliceType$4 = $sliceType(Vector);
	ptrType$3 = $ptrType(RingBuffer);
	ptrType$4 = $ptrType(Line);
	sliceType$5 = $sliceType(ptrType$4);
	ptrType$5 = $ptrType(Circle);
	ptrType$6 = $ptrType(ConvexPolygon);
	ptrType$7 = $ptrType(ContactSet);
	sliceType$6 = $sliceType($emptyInterface);
	sliceType$7 = $sliceType($String);
	ptrType$8 = $ptrType(Shape);
	sliceType$8 = $sliceType(Axis);
	ptrType$9 = $ptrType(Collision);
	mapType = $mapType(ptrType$2, $Bool);
	Vector.prototype.Clone = function() {
		var clone, v;
		v = this;
		clone = $makeSlice(Vector, v.$length);
		$copySlice(clone, v);
		return clone;
	};
	$ptrType(Vector).prototype.Clone = function() { return this.$get().Clone(); };
	Vector.prototype.Add = function(vs) {
		var _i, _ref, dim, i, v, vs;
		v = this;
		dim = v.$length;
		_ref = vs;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			if (((i < 0 || i >= vs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vs.$array[vs.$offset + i]).$length > dim) {
				axpyUnitaryTo($convertSliceType(v, sliceType), 1, $convertSliceType(v, sliceType), $convertSliceType($subslice(((i < 0 || i >= vs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vs.$array[vs.$offset + i]), 0, dim), sliceType));
			} else {
				axpyUnitaryTo($convertSliceType(v, sliceType), 1, $convertSliceType(v, sliceType), $convertSliceType(((i < 0 || i >= vs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vs.$array[vs.$offset + i]), sliceType));
			}
			_i++;
		}
		return v;
	};
	$ptrType(Vector).prototype.Add = function(vs) { return this.$get().Add(vs); };
	Vector.prototype.Sub = function(vs) {
		var _i, _ref, dim, i, v, vs;
		v = this;
		dim = v.$length;
		_ref = vs;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			if (((i < 0 || i >= vs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vs.$array[vs.$offset + i]).$length > dim) {
				axpyUnitaryTo($convertSliceType(v, sliceType), -1, $convertSliceType($subslice(((i < 0 || i >= vs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vs.$array[vs.$offset + i]), 0, dim), sliceType), $convertSliceType(v, sliceType));
			} else {
				axpyUnitaryTo($convertSliceType(v, sliceType), -1, $convertSliceType(((i < 0 || i >= vs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vs.$array[vs.$offset + i]), sliceType), $convertSliceType(v, sliceType));
			}
			_i++;
		}
		return v;
	};
	$ptrType(Vector).prototype.Sub = function(vs) { return this.$get().Sub(vs); };
	Vector.prototype.Scale = function(size) {
		var size, v;
		v = this;
		scalUnitaryTo($convertSliceType(v, sliceType), size, $convertSliceType(v, sliceType));
		return v;
	};
	$ptrType(Vector).prototype.Scale = function(size) { return this.$get().Scale(size); };
	Vector.prototype.Equal = function(v2) {
		var _i, _ref, i, v, v2;
		v = this;
		if (!((v.$length === v2.$length))) {
			return false;
		}
		_ref = v;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			if (math.Abs(((i < 0 || i >= v.$length) ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + i]) - ((i < 0 || i >= v2.$length) ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + i])) > 1e-08) {
				return false;
			}
			_i++;
		}
		return true;
	};
	$ptrType(Vector).prototype.Equal = function(v2) { return this.$get().Equal(v2); };
	Vector.prototype.Magnitude = function() {
		var v;
		v = this;
		return math.Sqrt(v.Magnitude2());
	};
	$ptrType(Vector).prototype.Magnitude = function() { return this.$get().Magnitude(); };
	Vector.prototype.Magnitude2 = function() {
		var _i, _ref, result, scalar, v;
		v = this;
		result = 0;
		_ref = v;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			scalar = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			result = result + (scalar * scalar);
			_i++;
		}
		return result;
	};
	$ptrType(Vector).prototype.Magnitude2 = function() { return this.$get().Magnitude2(); };
	Vector.prototype.Unit = function() {
		var _i, _ref, i, l, v;
		v = this;
		l = v.Magnitude();
		if (l < 1e-08) {
			return v;
		}
		_ref = v;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			((i < 0 || i >= v.$length) ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + i] = ((i < 0 || i >= v.$length) ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + i]) / l);
			_i++;
		}
		return v;
	};
	$ptrType(Vector).prototype.Unit = function() { return this.$get().Unit(); };
	Dot = function(v1, v2) {
		var _i, _ref, _tmp, _tmp$1, _tmp$2, dim1, dim2, i, result, v1, v2;
		_tmp = 0;
		_tmp$1 = v1.$length;
		_tmp$2 = v2.$length;
		result = _tmp;
		dim1 = _tmp$1;
		dim2 = _tmp$2;
		if (dim1 > dim2) {
			v2 = $appendSlice(v2, $convertSliceType($makeSlice(Vector, (dim1 - dim2 >> 0)), sliceType));
		}
		if (dim1 < dim2) {
			v1 = $appendSlice(v1, $convertSliceType($makeSlice(Vector, (dim2 - dim1 >> 0)), sliceType));
		}
		_ref = v1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			result = result + (((i < 0 || i >= v1.$length) ? ($throwRuntimeError("index out of range"), undefined) : v1.$array[v1.$offset + i]) * ((i < 0 || i >= v2.$length) ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + i]));
			_i++;
		}
		return result;
	};
	$pkg.Dot = Dot;
	Vector.prototype.Dot = function(v2) {
		var v, v2;
		v = this;
		return Dot(v, v2);
	};
	$ptrType(Vector).prototype.Dot = function(v2) { return this.$get().Dot(v2); };
	Vector.prototype.Cross = function(v2) {
		var v, v2;
		v = this;
		if (!((v.$length === 3)) || !((v2.$length === 3))) {
			return Vector.nil;
		}
		return new Vector([(1 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 1]) * (2 >= v2.$length ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + 2]) - (2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2]) * (1 >= v2.$length ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + 1]), (2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2]) * (0 >= v2.$length ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + 0]) - (0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0]) * (2 >= v2.$length ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + 2]), (0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0]) * (2 >= v2.$length ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + 2]) - (2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2]) * (0 >= v2.$length ? ($throwRuntimeError("index out of range"), undefined) : v2.$array[v2.$offset + 0])]);
	};
	$ptrType(Vector).prototype.Cross = function(v2) { return this.$get().Cross(v2); };
	Vector.prototype.Rotate = function(angle, as) {
		var _1, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, angle, as, axis, cos, dim, sin, v, x, y, z, z$1;
		v = this;
		_tmp = 2;
		_tmp$1 = v.$length;
		axis = _tmp;
		dim = _tmp$1;
		if (dim === 0) {
			return v;
		}
		if (as.$length > 0) {
			axis = (0 >= as.$length ? ($throwRuntimeError("index out of range"), undefined) : as.$array[as.$offset + 0]);
		}
		if ((dim === 1) && !((axis === 2))) {
			v = $append(v, 0, 0);
		}
		if ((dim < 2 && (axis === 2)) || ((dim === 2) && !((axis === 2)))) {
			v = $append(v, 0);
		}
		_tmp$2 = (0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0]);
		_tmp$3 = (1 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 1]);
		x = _tmp$2;
		y = _tmp$3;
		_tmp$4 = math.Cos(angle);
		_tmp$5 = math.Sin(angle);
		cos = _tmp$4;
		sin = _tmp$5;
		_1 = axis;
		if (_1 === (0)) {
			z = (2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2]);
			(1 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 1] = y * cos - z * sin);
			(2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2] = y * sin + z * cos);
		} else if (_1 === (1)) {
			z$1 = (2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2]);
			(0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0] = x * cos + z$1 * sin);
			(2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2] = -x * sin + z$1 * cos);
		} else if (_1 === (2)) {
			(0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0] = x * cos - y * sin);
			(1 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 1] = x * sin + y * cos);
		}
		if (dim > 3) {
			return $subslice(v, 0, 3);
		}
		return v;
	};
	$ptrType(Vector).prototype.Rotate = function(angle, as) { return this.$get().Rotate(angle, as); };
	Vector.prototype.X = function() {
		var v;
		v = this;
		if (v.$length < 1) {
			return 0;
		}
		return (0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0]);
	};
	$ptrType(Vector).prototype.X = function() { return this.$get().X(); };
	Vector.prototype.Y = function() {
		var v;
		v = this;
		if (v.$length < 2) {
			return 0;
		}
		return (1 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 1]);
	};
	$ptrType(Vector).prototype.Y = function() { return this.$get().Y(); };
	Vector.prototype.Z = function() {
		var v;
		v = this;
		if (v.$length < 3) {
			return 0;
		}
		return (2 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 2]);
	};
	$ptrType(Vector).prototype.Z = function() { return this.$get().Z(); };
	NewSpace = function(spaceWidth, spaceHeight, cellWidth, cellHeight) {
		var _q, _q$1, cellHeight, cellWidth, sp, spaceHeight, spaceWidth;
		sp = new Space.ptr(sliceType$2.nil, cellWidth, cellHeight);
		sp.Resize((_q = spaceWidth / cellWidth, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")), (_q$1 = spaceHeight / cellHeight, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero")));
		return sp;
	};
	$pkg.NewSpace = NewSpace;
	Space.ptr.prototype.AddSingle = function(obj) {
		var {obj, sp, $s, $r, $c} = $restore(this, {obj});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		sp = this;
		if (sp === ptrType$1.nil) {
			$panic(new $String("ERROR: space is nil"));
		}
		obj.Space = sp;
		$r = obj.Update(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Space.ptr.prototype.AddSingle, $c: true, $r, obj, sp, $s};return $f;
	};
	Space.prototype.AddSingle = function(obj) { return this.$val.AddSingle(obj); };
	Space.ptr.prototype.Add = function(objects) {
		var {_i, _ref, obj, objects, sp, $s, $r, $c} = $restore(this, {objects});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		sp = this;
		if (sp === ptrType$1.nil) {
			$panic(new $String("ERROR: space is nil"));
		}
		_ref = objects;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			obj = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			obj.Space = sp;
			$r = obj.Update(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Space.ptr.prototype.Add, $c: true, $r, _i, _ref, obj, objects, sp, $s};return $f;
	};
	Space.prototype.Add = function(objects) { return this.$val.Add(objects); };
	Space.ptr.prototype.RemoveSingle = function(obj) {
		var cell, obj, sp;
		sp = this;
		if (sp === ptrType$1.nil) {
			$panic(new $String("ERROR: space is nil"));
		}
		while (true) {
			if (!(0 < obj.TouchingCells.Cnt)) { break; }
			cell = $assertType(obj.TouchingCells.Pop(), ptrType);
			cell.unregister(obj);
		}
		obj.Space = ptrType$1.nil;
	};
	Space.prototype.RemoveSingle = function(obj) { return this.$val.RemoveSingle(obj); };
	Space.ptr.prototype.Remove = function(objects) {
		var _i, _ref, cell, obj, objects, sp;
		sp = this;
		if (sp === ptrType$1.nil) {
			$panic(new $String("ERROR: space is nil"));
		}
		_ref = objects;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			obj = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			while (true) {
				if (!(0 < obj.TouchingCells.Cnt)) { break; }
				cell = $assertType(obj.TouchingCells.Pop(), ptrType);
				cell.unregister(obj);
			}
			obj.Space = ptrType$1.nil;
			_i++;
		}
	};
	Space.prototype.Remove = function(objects) { return this.$val.Remove(objects); };
	Space.ptr.prototype.Objects = function() {
		var _entry, _i, _i$1, _key, _ref, _ref$1, _tuple, added, cx, cy, i, o, objects, objectsAdded, rb, sp, x, x$1, x$2;
		sp = this;
		objectsAdded = $makeMap(ptrType$2.keyFor, []);
		objects = new sliceType$3([]);
		_ref = sp.Cells;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			cy = _i;
			_ref$1 = (x = sp.Cells, ((cy < 0 || cy >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + cy]));
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				cx = _i$1;
				rb = (x$1 = (x$2 = sp.Cells, ((cy < 0 || cy >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + cy])), ((cx < 0 || cx >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + cx])).Objects;
				i = rb.StFrameId;
				while (true) {
					if (!(i < rb.EdFrameId)) { break; }
					o = $assertType(rb.GetByFrameId(i), ptrType$2);
					_tuple = (_entry = objectsAdded[ptrType$2.keyFor(o)], _entry !== undefined ? [_entry.v, true] : [false, false]);
					added = _tuple[1];
					if (!added) {
						objects = $append(objects, o);
						_key = o; (objectsAdded || $throwRuntimeError("assignment to entry in nil map"))[ptrType$2.keyFor(_key)] = { k: _key, v: true };
					}
					i = i + (1) >> 0;
				}
				_i$1++;
			}
			_i++;
		}
		return objects;
	};
	Space.prototype.Objects = function() { return this.$val.Objects(); };
	Space.ptr.prototype.Resize = function(width, height) {
		var height, sp, width, x, x$1, x$2, x$3, y;
		sp = this;
		sp.Cells = $makeSlice(sliceType$2, height);
		y = 0;
		while (true) {
			if (!(y < height)) { break; }
			(x = sp.Cells, ((y < 0 || y >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + y] = $makeSlice(sliceType$1, width)));
			x$1 = 0;
			while (true) {
				if (!(x$1 < width)) { break; }
				(x$2 = (x$3 = sp.Cells, ((y < 0 || y >= x$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + y])), ((x$1 < 0 || x$1 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + x$1] = newCell(x$1, y)));
				x$1 = x$1 + (1) >> 0;
			}
			y = y + (1) >> 0;
		}
	};
	Space.prototype.Resize = function(width, height) { return this.$val.Resize(width, height); };
	Space.ptr.prototype.Cell = function(x, y) {
		var sp, x, x$1, x$2, x$3, y;
		sp = this;
		if (y >= 0 && y < sp.Cells.$length && x >= 0 && x < (x$1 = sp.Cells, ((y < 0 || y >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + y])).$length) {
			return (x$2 = (x$3 = sp.Cells, ((y < 0 || y >= x$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + y])), ((x < 0 || x >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + x]));
		}
		return ptrType.nil;
	};
	Space.prototype.Cell = function(x, y) { return this.$val.Cell(x, y); };
	Space.ptr.prototype.CheckCells = function(x, y, w, h, tags) {
		var cell, h, i, ix, iy, obj, rb, sp, tags, w, x, y;
		sp = this;
		ix = x;
		while (true) {
			if (!(ix < (x + w >> 0))) { break; }
			iy = y;
			while (true) {
				if (!(iy < (y + h >> 0))) { break; }
				cell = sp.Cell(ix, iy);
				if (!(cell === ptrType.nil)) {
					rb = cell.Objects;
					if (tags.$length > 0) {
						if (cell.ContainsTags(tags)) {
							i = rb.StFrameId;
							while (true) {
								if (!(i < rb.EdFrameId)) { break; }
								obj = $assertType(rb.GetByFrameId(i), ptrType$2);
								if (obj.HasTags(tags)) {
									return obj;
								}
								i = i + (1) >> 0;
							}
						}
					} else if (cell.Occupied()) {
						return $assertType(rb.GetByFrameId(rb.StFrameId), ptrType$2);
					}
				}
				iy = iy + (1) >> 0;
			}
			ix = ix + (1) >> 0;
		}
		return ptrType$2.nil;
	};
	Space.prototype.CheckCells = function(x, y, w, h, tags) { return this.$val.CheckCells(x, y, w, h, tags); };
	Space.ptr.prototype.CheckCellsWorld = function(x, y, w, h, tags) {
		var _tuple, _tuple$1, ch, cw, h, sp, sx, sy, tags, w, x, y;
		sp = this;
		_tuple = sp.WorldToSpace(x, y);
		sx = _tuple[0];
		sy = _tuple[1];
		_tuple$1 = sp.WorldToSpace(w, h);
		cw = _tuple$1[0];
		ch = _tuple$1[1];
		return sp.CheckCells(sx, sy, cw, ch, tags);
	};
	Space.prototype.CheckCellsWorld = function(x, y, w, h, tags) { return this.$val.CheckCellsWorld(x, y, w, h, tags); };
	Space.ptr.prototype.UnregisterAllObjects = function() {
		var cell, i, o, rb, sp, x, x$1, x$2, x$3, y;
		sp = this;
		y = 0;
		while (true) {
			if (!(y < sp.Cells.$length)) { break; }
			x = 0;
			while (true) {
				if (!(x < (x$1 = sp.Cells, ((y < 0 || y >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + y])).$length)) { break; }
				cell = (x$2 = (x$3 = sp.Cells, ((y < 0 || y >= x$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + y])), ((x < 0 || x >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + x]));
				rb = cell.Objects;
				i = rb.StFrameId;
				while (true) {
					if (!(i < rb.EdFrameId)) { break; }
					o = $assertType(rb.GetByFrameId(i), ptrType$2);
					sp.RemoveSingle(o);
					i = i + (1) >> 0;
				}
				x = x + (1) >> 0;
			}
			y = y + (1) >> 0;
		}
	};
	Space.prototype.UnregisterAllObjects = function() { return this.$val.UnregisterAllObjects(); };
	Space.ptr.prototype.WorldToSpace = function(x, y) {
		var fx, fy, sp, x, y;
		sp = this;
		fx = ((math.Floor(x / (sp.CellWidth)) >> 0));
		fy = ((math.Floor(y / (sp.CellHeight)) >> 0));
		return [fx, fy];
	};
	Space.prototype.WorldToSpace = function(x, y) { return this.$val.WorldToSpace(x, y); };
	Space.ptr.prototype.SpaceToWorld = function(x, y) {
		var fx, fy, sp, x, y;
		sp = this;
		fx = (($imul(x, sp.CellWidth)));
		fy = (($imul(y, sp.CellHeight)));
		return [fx, fy];
	};
	Space.prototype.SpaceToWorld = function(x, y) { return this.$val.SpaceToWorld(x, y); };
	Space.ptr.prototype.Height = function() {
		var sp;
		sp = this;
		return sp.Cells.$length;
	};
	Space.prototype.Height = function() { return this.$val.Height(); };
	Space.ptr.prototype.Width = function() {
		var sp, x;
		sp = this;
		if (sp.Cells.$length > 0) {
			return (x = sp.Cells, (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])).$length;
		}
		return 0;
	};
	Space.prototype.Width = function() { return this.$val.Width(); };
	Space.ptr.prototype.CellsInLine = function(startX, startY, endX, endY) {
		var _q, _q$1, _q$2, _q$3, _tuple, _tuple$1, alternate, c, cell, cells, cx, cy, dv, endCell, endX, endY, p, pX, pY, sp, startX, startY;
		sp = this;
		cells = new sliceType$1([]);
		cell = sp.Cell(startX, startY);
		endCell = sp.Cell(endX, endY);
		if (!(cell === ptrType.nil) && !(endCell === ptrType.nil)) {
			dv = new Vector([((endX - startX >> 0)), ((endY - startY >> 0))]).Unit();
			(0 >= dv.$length ? ($throwRuntimeError("index out of range"), undefined) : dv.$array[dv.$offset + 0] = (0 >= dv.$length ? ($throwRuntimeError("index out of range"), undefined) : dv.$array[dv.$offset + 0]) * (((_q = sp.CellWidth / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")))));
			(1 >= dv.$length ? ($throwRuntimeError("index out of range"), undefined) : dv.$array[dv.$offset + 1] = (1 >= dv.$length ? ($throwRuntimeError("index out of range"), undefined) : dv.$array[dv.$offset + 1]) * (((_q$1 = sp.CellHeight / 2, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero")))));
			_tuple = sp.SpaceToWorld(startX, startY);
			pX = _tuple[0];
			pY = _tuple[1];
			p = new Vector([pX + ((_q$2 = sp.CellWidth / 2, (_q$2 === _q$2 && _q$2 !== 1/0 && _q$2 !== -1/0) ? _q$2 >> 0 : $throwRuntimeError("integer divide by zero"))), pY + ((_q$3 = sp.CellHeight / 2, (_q$3 === _q$3 && _q$3 !== 1/0 && _q$3 !== -1/0) ? _q$3 >> 0 : $throwRuntimeError("integer divide by zero")))]);
			alternate = false;
			while (true) {
				if (!(!(cell === ptrType.nil))) { break; }
				if (cell === endCell) {
					cells = $append(cells, cell);
					break;
				}
				cells = $append(cells, cell);
				if (alternate) {
					(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = (1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1]) + ((1 >= dv.$length ? ($throwRuntimeError("index out of range"), undefined) : dv.$array[dv.$offset + 1])));
				} else {
					(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = (0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0]) + ((0 >= dv.$length ? ($throwRuntimeError("index out of range"), undefined) : dv.$array[dv.$offset + 0])));
				}
				_tuple$1 = sp.WorldToSpace((0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0]), (1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1]));
				cx = _tuple$1[0];
				cy = _tuple$1[1];
				c = sp.Cell(cx, cy);
				if (!(c === cell)) {
					cell = c;
				}
				alternate = !alternate;
			}
		}
		return cells;
	};
	Space.prototype.CellsInLine = function(startX, startY, endX, endY) { return this.$val.CellsInLine(startX, startY, endX, endY); };
	NewLine = function(x, y, x2, y2) {
		var x, x2, y, y2;
		return new Line.ptr(new Vector([x, y]), new Vector([x2, y2]));
	};
	$pkg.NewLine = NewLine;
	Line.ptr.prototype.Project = function(axis) {
		var axis, line;
		line = this;
		return line.Vector().Scale(axis.Dot(line.Start.Sub(new sliceType$4([line.End]))));
	};
	Line.prototype.Project = function(axis) { return this.$val.Project(axis); };
	Line.ptr.prototype.Normal = function() {
		var dx, dy, line, x, x$1, x$2, x$3;
		line = this;
		dy = (x = line.End, (1 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 1])) - (x$1 = line.Start, (1 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 1]));
		dx = (x$2 = line.End, (0 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 0])) - (x$3 = line.Start, (0 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 0]));
		return new Vector([dy, -dx]).Unit();
	};
	Line.prototype.Normal = function() { return this.$val.Normal(); };
	Line.ptr.prototype.Vector = function() {
		var line;
		line = this;
		return line.End.Clone().Sub(new sliceType$4([line.Start])).Unit();
	};
	Line.prototype.Vector = function() { return this.$val.Vector(); };
	Line.ptr.prototype.IntersectionPointsLine = function(other) {
		var det, dx, dy, gamma, lambda, line, other, x, x$1, x$10, x$11, x$12, x$13, x$14, x$15, x$16, x$17, x$18, x$19, x$2, x$20, x$21, x$22, x$23, x$24, x$25, x$26, x$27, x$28, x$29, x$3, x$4, x$5, x$6, x$7, x$8, x$9;
		line = this;
		det = ((x = line.End, (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])) - (x$1 = line.Start, (0 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 0]))) * ((x$2 = other.End, (1 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 1])) - (x$3 = other.Start, (1 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 1]))) - ((x$4 = other.End, (0 >= x$4.$length ? ($throwRuntimeError("index out of range"), undefined) : x$4.$array[x$4.$offset + 0])) - (x$5 = other.Start, (0 >= x$5.$length ? ($throwRuntimeError("index out of range"), undefined) : x$5.$array[x$5.$offset + 0]))) * ((x$6 = line.End, (1 >= x$6.$length ? ($throwRuntimeError("index out of range"), undefined) : x$6.$array[x$6.$offset + 1])) - (x$7 = line.Start, (1 >= x$7.$length ? ($throwRuntimeError("index out of range"), undefined) : x$7.$array[x$7.$offset + 1])));
		if (!((det === 0))) {
			lambda = ((((x$8 = line.Start, (1 >= x$8.$length ? ($throwRuntimeError("index out of range"), undefined) : x$8.$array[x$8.$offset + 1])) - (x$9 = other.Start, (1 >= x$9.$length ? ($throwRuntimeError("index out of range"), undefined) : x$9.$array[x$9.$offset + 1]))) * ((x$10 = other.End, (0 >= x$10.$length ? ($throwRuntimeError("index out of range"), undefined) : x$10.$array[x$10.$offset + 0])) - (x$11 = other.Start, (0 >= x$11.$length ? ($throwRuntimeError("index out of range"), undefined) : x$11.$array[x$11.$offset + 0])))) - (((x$12 = line.Start, (0 >= x$12.$length ? ($throwRuntimeError("index out of range"), undefined) : x$12.$array[x$12.$offset + 0])) - (x$13 = other.Start, (0 >= x$13.$length ? ($throwRuntimeError("index out of range"), undefined) : x$13.$array[x$13.$offset + 0]))) * ((x$14 = other.End, (1 >= x$14.$length ? ($throwRuntimeError("index out of range"), undefined) : x$14.$array[x$14.$offset + 1])) - (x$15 = other.Start, (1 >= x$15.$length ? ($throwRuntimeError("index out of range"), undefined) : x$15.$array[x$15.$offset + 1])))) + 1) / det;
			gamma = ((((x$16 = line.Start, (1 >= x$16.$length ? ($throwRuntimeError("index out of range"), undefined) : x$16.$array[x$16.$offset + 1])) - (x$17 = other.Start, (1 >= x$17.$length ? ($throwRuntimeError("index out of range"), undefined) : x$17.$array[x$17.$offset + 1]))) * ((x$18 = line.End, (0 >= x$18.$length ? ($throwRuntimeError("index out of range"), undefined) : x$18.$array[x$18.$offset + 0])) - (x$19 = line.Start, (0 >= x$19.$length ? ($throwRuntimeError("index out of range"), undefined) : x$19.$array[x$19.$offset + 0])))) - (((x$20 = line.Start, (0 >= x$20.$length ? ($throwRuntimeError("index out of range"), undefined) : x$20.$array[x$20.$offset + 0])) - (x$21 = other.Start, (0 >= x$21.$length ? ($throwRuntimeError("index out of range"), undefined) : x$21.$array[x$21.$offset + 0]))) * ((x$22 = line.End, (1 >= x$22.$length ? ($throwRuntimeError("index out of range"), undefined) : x$22.$array[x$22.$offset + 1])) - (x$23 = line.Start, (1 >= x$23.$length ? ($throwRuntimeError("index out of range"), undefined) : x$23.$array[x$23.$offset + 1])))) + 1) / det;
			if ((0 < lambda && lambda < 1) && (0 < gamma && gamma < 1)) {
				dx = (x$24 = line.End, (0 >= x$24.$length ? ($throwRuntimeError("index out of range"), undefined) : x$24.$array[x$24.$offset + 0])) - (x$25 = line.Start, (0 >= x$25.$length ? ($throwRuntimeError("index out of range"), undefined) : x$25.$array[x$25.$offset + 0]));
				dy = (x$26 = line.End, (1 >= x$26.$length ? ($throwRuntimeError("index out of range"), undefined) : x$26.$array[x$26.$offset + 1])) - (x$27 = line.Start, (1 >= x$27.$length ? ($throwRuntimeError("index out of range"), undefined) : x$27.$array[x$27.$offset + 1]));
				return new Vector([(x$28 = line.Start, (0 >= x$28.$length ? ($throwRuntimeError("index out of range"), undefined) : x$28.$array[x$28.$offset + 0])) + (lambda * dx), (x$29 = line.Start, (1 >= x$29.$length ? ($throwRuntimeError("index out of range"), undefined) : x$29.$array[x$29.$offset + 1])) + (lambda * dy)]);
			}
		}
		return Vector.nil;
	};
	Line.prototype.IntersectionPointsLine = function(other) { return this.$val.IntersectionPointsLine(other); };
	Line.ptr.prototype.IntersectionPointsCircle = function(circle) {
		var a, b, c, circle, cp, det, diff, lEnd, lStart, line, points, t, t$1, x, x$1, x$2, x$3, x$4, x$5;
		line = this;
		points = new sliceType$4([]);
		cp = new Vector([circle.X, circle.Y]);
		lStart = line.Start.Sub(new sliceType$4([cp]));
		lEnd = line.End.Sub(new sliceType$4([cp]));
		diff = lEnd.Sub(new sliceType$4([lStart]));
		a = (0 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 0]) * (0 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 0]) + (1 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 1]) * (1 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 1]);
		b = 2 * (((0 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 0]) * (0 >= lStart.$length ? ($throwRuntimeError("index out of range"), undefined) : lStart.$array[lStart.$offset + 0])) + ((1 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 1]) * (1 >= lStart.$length ? ($throwRuntimeError("index out of range"), undefined) : lStart.$array[lStart.$offset + 1])));
		c = ((0 >= lStart.$length ? ($throwRuntimeError("index out of range"), undefined) : lStart.$array[lStart.$offset + 0]) * (0 >= lStart.$length ? ($throwRuntimeError("index out of range"), undefined) : lStart.$array[lStart.$offset + 0])) + ((1 >= lStart.$length ? ($throwRuntimeError("index out of range"), undefined) : lStart.$array[lStart.$offset + 1]) * (1 >= lStart.$length ? ($throwRuntimeError("index out of range"), undefined) : lStart.$array[lStart.$offset + 1])) - (circle.Radius * circle.Radius);
		det = b * b - (4 * a * c);
		if (det < 0) {
		} else if (det === 0) {
			t = -b / (2 * a);
			if (t >= 0 && t <= 1) {
				points = $append(points, new Vector([(x = line.Start, (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])) + t * (0 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 0]), (x$1 = line.Start, (1 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 1])) + t * (1 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 1])]));
			}
		} else {
			t$1 = (-b + math.Sqrt(det)) / (2 * a);
			if (t$1 >= 0 && t$1 <= 1) {
				points = $append(points, new Vector([(x$2 = line.Start, (0 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 0])) + t$1 * (0 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 0]), (x$3 = line.Start, (1 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 1])) + t$1 * (1 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 1])]));
			}
			t$1 = (-b - math.Sqrt(det)) / (2 * a);
			if (t$1 >= 0 && t$1 <= 1) {
				points = $append(points, new Vector([(x$4 = line.Start, (0 >= x$4.$length ? ($throwRuntimeError("index out of range"), undefined) : x$4.$array[x$4.$offset + 0])) + t$1 * (0 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 0]), (x$5 = line.Start, (1 >= x$5.$length ? ($throwRuntimeError("index out of range"), undefined) : x$5.$array[x$5.$offset + 1])) + t$1 * (1 >= diff.$length ? ($throwRuntimeError("index out of range"), undefined) : diff.$array[diff.$offset + 1])]));
			}
		}
		return points;
	};
	Line.prototype.IntersectionPointsCircle = function(circle) { return this.$val.IntersectionPointsCircle(circle); };
	NewConvexPolygon = function(points) {
		var cp, points;
		cp = new ConvexPolygon.ptr(NewRingBuffer(6), 0, 0, true);
		cp.AddPoints(points);
		return cp;
	};
	$pkg.NewConvexPolygon = NewConvexPolygon;
	ConvexPolygon.ptr.prototype.GetPointByOffset = function(offset) {
		var cp, offset;
		cp = this;
		if (cp.Points.Cnt <= offset) {
			return Vector.nil;
		}
		return $assertType(cp.Points.GetByFrameId(cp.Points.StFrameId + offset >> 0), Vector);
	};
	ConvexPolygon.prototype.GetPointByOffset = function(offset) { return this.$val.GetPointByOffset(offset); };
	ConvexPolygon.ptr.prototype.Clone = function() {
		var cp, i, newPoly;
		cp = this;
		newPoly = NewConvexPolygon(sliceType.nil);
		newPoly.X = cp.X;
		newPoly.Y = cp.Y;
		i = 0;
		while (true) {
			if (!(i < cp.Points.Cnt)) { break; }
			newPoly.Points.Put(cp.GetPointByOffset(i));
			i = i + (1) >> 0;
		}
		newPoly.Closed = cp.Closed;
		return newPoly;
	};
	ConvexPolygon.prototype.Clone = function() { return this.$val.Clone(); };
	ConvexPolygon.ptr.prototype.AddPoints = function(vertexPositions) {
		var cp, v, vertexPositions, x;
		cp = this;
		v = 0;
		while (true) {
			if (!(v < vertexPositions.$length)) { break; }
			cp.Points.Put(new Vector([((v < 0 || v >= vertexPositions.$length) ? ($throwRuntimeError("index out of range"), undefined) : vertexPositions.$array[vertexPositions.$offset + v]), (x = v + 1 >> 0, ((x < 0 || x >= vertexPositions.$length) ? ($throwRuntimeError("index out of range"), undefined) : vertexPositions.$array[vertexPositions.$offset + x]))]));
			v = v + (2) >> 0;
		}
	};
	ConvexPolygon.prototype.AddPoints = function(vertexPositions) { return this.$val.AddPoints(vertexPositions); };
	ConvexPolygon.ptr.prototype.UpdateAsRectangle = function(x, y, w, h) {
		var _1, cp, h, i, thatVec, w, x, y;
		cp = this;
		if (!((4 === cp.Points.Cnt))) {
			$panic(new $String("ConvexPolygon not having exactly 4 vertices to form a rectangle#1!"));
		}
		i = 0;
		while (true) {
			if (!(i < cp.Points.Cnt)) { break; }
			thatVec = cp.GetPointByOffset(i);
			if (Vector.nil === thatVec) {
				$panic(new $String("ConvexPolygon not having exactly 4 vertices to form a rectangle#2!"));
			}
			_1 = i;
			if (_1 === (0)) {
				(0 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 0] = x);
				(1 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 1] = y);
			} else if (_1 === (1)) {
				(0 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 0] = x + w);
				(1 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 1] = y);
			} else if (_1 === (2)) {
				(0 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 0] = x + w);
				(1 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 1] = y + h);
			} else if (_1 === (3)) {
				(0 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 0] = x);
				(1 >= thatVec.$length ? ($throwRuntimeError("index out of range"), undefined) : thatVec.$array[thatVec.$offset + 1] = y + h);
			}
			i = i + (1) >> 0;
		}
		return true;
	};
	ConvexPolygon.prototype.UpdateAsRectangle = function(x, y, w, h) { return this.$val.UpdateAsRectangle(x, y, w, h); };
	ConvexPolygon.ptr.prototype.Lines = function() {
		var _tmp, _tmp$1, cp, end, i, line, lines, linesCnt, start, vertices, x;
		cp = this;
		vertices = cp.Transformed();
		linesCnt = vertices.$length;
		if (!cp.Closed) {
			linesCnt = linesCnt - (1) >> 0;
		}
		lines = $makeSlice(sliceType$5, linesCnt);
		i = 0;
		while (true) {
			if (!(i < linesCnt)) { break; }
			_tmp = ((i < 0 || i >= vertices.$length) ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + i]);
			_tmp$1 = (0 >= vertices.$length ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + 0]);
			start = _tmp;
			end = _tmp$1;
			if (i < (vertices.$length - 1 >> 0)) {
				end = (x = i + 1 >> 0, ((x < 0 || x >= vertices.$length) ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + x]));
			}
			line = NewLine((0 >= start.$length ? ($throwRuntimeError("index out of range"), undefined) : start.$array[start.$offset + 0]), (1 >= start.$length ? ($throwRuntimeError("index out of range"), undefined) : start.$array[start.$offset + 1]), (0 >= end.$length ? ($throwRuntimeError("index out of range"), undefined) : end.$array[end.$offset + 0]), (1 >= end.$length ? ($throwRuntimeError("index out of range"), undefined) : end.$array[end.$offset + 1]));
			((i < 0 || i >= lines.$length) ? ($throwRuntimeError("index out of range"), undefined) : lines.$array[lines.$offset + i] = line);
			i = i + (1) >> 0;
		}
		return lines;
	};
	ConvexPolygon.prototype.Lines = function() { return this.$val.Lines(); };
	ConvexPolygon.ptr.prototype.Transformed = function() {
		var cp, i, point, transformed;
		cp = this;
		transformed = $makeSlice(sliceType$4, cp.Points.Cnt);
		i = 0;
		while (true) {
			if (!(i < cp.Points.Cnt)) { break; }
			point = cp.GetPointByOffset(i);
			((i < 0 || i >= transformed.$length) ? ($throwRuntimeError("index out of range"), undefined) : transformed.$array[transformed.$offset + i] = new Vector([(0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]) + cp.X, (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]) + cp.Y]));
			i = i + (1) >> 0;
		}
		return transformed;
	};
	ConvexPolygon.prototype.Transformed = function() { return this.$val.Transformed(); };
	ConvexPolygon.ptr.prototype.Bounds = function() {
		var bottomRight, cp, i, point, topLeft, transformed, x, x$1;
		cp = this;
		transformed = cp.Transformed();
		topLeft = new Vector([(x = (0 >= transformed.$length ? ($throwRuntimeError("index out of range"), undefined) : transformed.$array[transformed.$offset + 0]), (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])), (x$1 = (0 >= transformed.$length ? ($throwRuntimeError("index out of range"), undefined) : transformed.$array[transformed.$offset + 0]), (1 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 1]))]);
		bottomRight = topLeft.Clone();
		i = 0;
		while (true) {
			if (!(i < transformed.$length)) { break; }
			point = ((i < 0 || i >= transformed.$length) ? ($throwRuntimeError("index out of range"), undefined) : transformed.$array[transformed.$offset + i]);
			if ((0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]) < (0 >= topLeft.$length ? ($throwRuntimeError("index out of range"), undefined) : topLeft.$array[topLeft.$offset + 0])) {
				(0 >= topLeft.$length ? ($throwRuntimeError("index out of range"), undefined) : topLeft.$array[topLeft.$offset + 0] = (0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]));
			} else if ((0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]) > (0 >= bottomRight.$length ? ($throwRuntimeError("index out of range"), undefined) : bottomRight.$array[bottomRight.$offset + 0])) {
				(0 >= bottomRight.$length ? ($throwRuntimeError("index out of range"), undefined) : bottomRight.$array[bottomRight.$offset + 0] = (0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]));
			}
			if ((1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]) < (1 >= topLeft.$length ? ($throwRuntimeError("index out of range"), undefined) : topLeft.$array[topLeft.$offset + 1])) {
				(1 >= topLeft.$length ? ($throwRuntimeError("index out of range"), undefined) : topLeft.$array[topLeft.$offset + 1] = (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]));
			} else if ((1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]) > (1 >= bottomRight.$length ? ($throwRuntimeError("index out of range"), undefined) : bottomRight.$array[bottomRight.$offset + 1])) {
				(1 >= bottomRight.$length ? ($throwRuntimeError("index out of range"), undefined) : bottomRight.$array[bottomRight.$offset + 1] = (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]));
			}
			i = i + (1) >> 0;
		}
		return [topLeft, bottomRight];
	};
	ConvexPolygon.prototype.Bounds = function() { return this.$val.Bounds(); };
	ConvexPolygon.ptr.prototype.Position = function() {
		var cp;
		cp = this;
		return [cp.X, cp.Y];
	};
	ConvexPolygon.prototype.Position = function() { return this.$val.Position(); };
	ConvexPolygon.ptr.prototype.SetPosition = function(x, y) {
		var cp, x, y;
		cp = this;
		cp.X = x;
		cp.Y = y;
	};
	ConvexPolygon.prototype.SetPosition = function(x, y) { return this.$val.SetPosition(x, y); };
	ConvexPolygon.ptr.prototype.SetPositionVec = function(vec) {
		var cp, vec;
		cp = this;
		cp.X = vec.X();
		cp.Y = vec.Y();
	};
	ConvexPolygon.prototype.SetPositionVec = function(vec) { return this.$val.SetPositionVec(vec); };
	ConvexPolygon.ptr.prototype.Move = function(x, y) {
		var cp, x, y;
		cp = this;
		cp.X = cp.X + (x);
		cp.Y = cp.Y + (y);
	};
	ConvexPolygon.prototype.Move = function(x, y) { return this.$val.Move(x, y); };
	ConvexPolygon.ptr.prototype.MoveVec = function(vec) {
		var cp, vec;
		cp = this;
		cp.X = cp.X + (vec.X());
		cp.Y = cp.Y + (vec.Y());
	};
	ConvexPolygon.prototype.MoveVec = function(vec) { return this.$val.MoveVec(vec); };
	ConvexPolygon.ptr.prototype.Center = function() {
		var _i, _ref, cp, denom, pos, v, vertices;
		cp = this;
		pos = new Vector([0, 0]);
		vertices = cp.Transformed();
		_ref = vertices;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			pos.Add(new sliceType$4([v]));
			_i++;
		}
		denom = (vertices.$length);
		(0 >= pos.$length ? ($throwRuntimeError("index out of range"), undefined) : pos.$array[pos.$offset + 0] = (0 >= pos.$length ? ($throwRuntimeError("index out of range"), undefined) : pos.$array[pos.$offset + 0]) / (denom));
		(1 >= pos.$length ? ($throwRuntimeError("index out of range"), undefined) : pos.$array[pos.$offset + 1] = (1 >= pos.$length ? ($throwRuntimeError("index out of range"), undefined) : pos.$array[pos.$offset + 1]) / (denom));
		return pos;
	};
	ConvexPolygon.prototype.Center = function() { return this.$val.Center(); };
	ConvexPolygon.ptr.prototype.Project = function(axis) {
		var axis, cp, i, max, min, p, vertices, x, x$1, x$2, x$3;
		cp = this;
		axis = axis.Unit();
		vertices = cp.Transformed();
		min = axis.Dot(new Vector([(x = (0 >= vertices.$length ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + 0]), (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])), (x$1 = (0 >= vertices.$length ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + 0]), (1 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 1]))]));
		max = min;
		i = 1;
		while (true) {
			if (!(i < vertices.$length)) { break; }
			p = axis.Dot(new Vector([(x$2 = ((i < 0 || i >= vertices.$length) ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + i]), (0 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 0])), (x$3 = ((i < 0 || i >= vertices.$length) ? ($throwRuntimeError("index out of range"), undefined) : vertices.$array[vertices.$offset + i]), (1 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 1]))]));
			if (p < min) {
				min = p;
			} else if (p > max) {
				max = p;
			}
			i = i + (1) >> 0;
		}
		return new Projection.ptr(min, max);
	};
	ConvexPolygon.prototype.Project = function(axis) { return this.$val.Project(axis); };
	ConvexPolygon.ptr.prototype.SATAxes = function() {
		var _i, _ref, axes, cp, i, line, lines;
		cp = this;
		lines = cp.Lines();
		axes = $makeSlice(sliceType$4, lines.$length);
		_ref = lines;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			line = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= axes.$length) ? ($throwRuntimeError("index out of range"), undefined) : axes.$array[axes.$offset + i] = line.Normal());
			_i++;
		}
		return axes;
	};
	ConvexPolygon.prototype.SATAxes = function() { return this.$val.SATAxes(); };
	ConvexPolygon.ptr.prototype.PointInside = function(point) {
		var _i, _ref, contactCount, line, point, pointLine, polygon;
		polygon = this;
		pointLine = NewLine((0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]), (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]), (0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]) + 9.99999999999e+11, (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]));
		contactCount = 0;
		_ref = polygon.Lines();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			line = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (!(line.IntersectionPointsLine(pointLine) === Vector.nil)) {
				contactCount = contactCount + (1) >> 0;
			}
			_i++;
		}
		return contactCount === 1;
	};
	ConvexPolygon.prototype.PointInside = function(point) { return this.$val.PointInside(point); };
	NewContactSet = function() {
		return new ContactSet.ptr(new sliceType$4([]), new Vector([0, 0]), new Vector([0, 0]));
	};
	$pkg.NewContactSet = NewContactSet;
	ContactSet.ptr.prototype.LeftmostPoint = function() {
		var _i, _ref, cs, left, point;
		cs = this;
		left = Vector.nil;
		_ref = cs.Points;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			point = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (left === Vector.nil || (0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]) < (0 >= left.$length ? ($throwRuntimeError("index out of range"), undefined) : left.$array[left.$offset + 0])) {
				left = point;
			}
			_i++;
		}
		return left;
	};
	ContactSet.prototype.LeftmostPoint = function() { return this.$val.LeftmostPoint(); };
	ContactSet.ptr.prototype.RightmostPoint = function() {
		var _i, _ref, cs, point, right;
		cs = this;
		right = Vector.nil;
		_ref = cs.Points;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			point = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (right === Vector.nil || (0 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 0]) > (0 >= right.$length ? ($throwRuntimeError("index out of range"), undefined) : right.$array[right.$offset + 0])) {
				right = point;
			}
			_i++;
		}
		return right;
	};
	ContactSet.prototype.RightmostPoint = function() { return this.$val.RightmostPoint(); };
	ContactSet.ptr.prototype.TopmostPoint = function() {
		var _i, _ref, cs, point, top;
		cs = this;
		top = Vector.nil;
		_ref = cs.Points;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			point = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (top === Vector.nil || (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]) < (1 >= top.$length ? ($throwRuntimeError("index out of range"), undefined) : top.$array[top.$offset + 1])) {
				top = point;
			}
			_i++;
		}
		return top;
	};
	ContactSet.prototype.TopmostPoint = function() { return this.$val.TopmostPoint(); };
	ContactSet.ptr.prototype.BottommostPoint = function() {
		var _i, _ref, bottom, cs, point;
		cs = this;
		bottom = Vector.nil;
		_ref = cs.Points;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			point = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (bottom === Vector.nil || (1 >= point.$length ? ($throwRuntimeError("index out of range"), undefined) : point.$array[point.$offset + 1]) > (1 >= bottom.$length ? ($throwRuntimeError("index out of range"), undefined) : bottom.$array[bottom.$offset + 1])) {
				bottom = point;
			}
			_i++;
		}
		return bottom;
	};
	ContactSet.prototype.BottommostPoint = function() { return this.$val.BottommostPoint(); };
	ConvexPolygon.ptr.prototype.Intersection = function(dx, dy, other) {
		var _i, _i$1, _i$2, _i$3, _ref, _ref$1, _ref$2, _ref$3, _tuple, _tuple$1, circle, contactSet, cp, deltaMagnitude, dx, dy, isCircle, isPoly, line, line$1, mtv, ogMagnitude, ogX, ogY, other, otherLine, point, point$1, poly, x, x$1, x$2, x$3;
		cp = this;
		contactSet = NewContactSet();
		ogX = cp.X;
		ogY = cp.Y;
		cp.X = cp.X + (dx);
		cp.Y = cp.Y + (dy);
		_tuple = $assertType(other, ptrType$5, true);
		circle = _tuple[0];
		isCircle = _tuple[1];
		if (isCircle) {
			_ref = cp.Lines();
			_i = 0;
			while (true) {
				if (!(_i < _ref.$length)) { break; }
				line = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
				contactSet.Points = $appendSlice(contactSet.Points, line.IntersectionPointsCircle(circle));
				_i++;
			}
		} else {
			_tuple$1 = $assertType(other, ptrType$6, true);
			poly = _tuple$1[0];
			isPoly = _tuple$1[1];
			if (isPoly) {
				_ref$1 = cp.Lines();
				_i$1 = 0;
				while (true) {
					if (!(_i$1 < _ref$1.$length)) { break; }
					line$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
					_ref$2 = poly.Lines();
					_i$2 = 0;
					while (true) {
						if (!(_i$2 < _ref$2.$length)) { break; }
						otherLine = ((_i$2 < 0 || _i$2 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$2]);
						point = line$1.IntersectionPointsLine(otherLine);
						if (!(point === Vector.nil)) {
							contactSet.Points = $append(contactSet.Points, point);
						}
						_i$2++;
					}
					_i$1++;
				}
			}
		}
		if (contactSet.Points.$length > 0) {
			_ref$3 = contactSet.Points;
			_i$3 = 0;
			while (true) {
				if (!(_i$3 < _ref$3.$length)) { break; }
				point$1 = ((_i$3 < 0 || _i$3 >= _ref$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$3.$array[_ref$3.$offset + _i$3]);
				contactSet.Center = contactSet.Center.Add(new sliceType$4([point$1]));
				_i$3++;
			}
			(x$1 = contactSet.Center, (0 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 0] = (x = contactSet.Center, (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])) / ((contactSet.Points.$length))));
			(x$3 = contactSet.Center, (1 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 1] = (x$2 = contactSet.Center, (1 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 1])) / ((contactSet.Points.$length))));
			mtv = cp.calculateMTV(contactSet, other);
			if (!(mtv === Vector.nil)) {
				contactSet.MTV = mtv;
			}
		} else {
			contactSet = ptrType$7.nil;
		}
		if (!(contactSet === ptrType$7.nil) && (!((dx === 0)) || !((dy === 0)))) {
			deltaMagnitude = new Vector([dx, dy]).Magnitude();
			ogMagnitude = contactSet.MTV.Magnitude();
			contactSet.MTV = contactSet.MTV.Unit().Scale(ogMagnitude - deltaMagnitude);
		}
		cp.X = ogX;
		cp.Y = ogY;
		return contactSet;
	};
	ConvexPolygon.prototype.Intersection = function(dx, dy, other) { return this.$val.Intersection(dx, dy, other); };
	ConvexPolygon.ptr.prototype.calculateMTV = function(contactSet, otherShape) {
		var _i, _i$1, _ref, _ref$1, _ref$2, axis, axis$1, contactSet, cp, delta, other, otherShape, overlap, overlap$1, smallest;
		cp = this;
		delta = new Vector([0, 0]);
		smallest = new Vector([1.7976931348623157e+308, 0]);
		_ref = otherShape;
		if ($assertType(_ref, ptrType$6, true)[1]) {
			other = _ref.$val;
			_ref$1 = cp.SATAxes();
			_i = 0;
			while (true) {
				if (!(_i < _ref$1.$length)) { break; }
				axis = ((_i < 0 || _i >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i]);
				if (!$clone(cp.Project(axis), Projection).Overlapping($clone(other.Project(axis), Projection))) {
					return Vector.nil;
				}
				overlap = $clone(cp.Project(axis), Projection).Overlap($clone(other.Project(axis), Projection));
				if (smallest.Magnitude() > overlap) {
					smallest = axis.Scale(overlap);
				}
				_i++;
			}
			_ref$2 = other.SATAxes();
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$2.$length)) { break; }
				axis$1 = ((_i$1 < 0 || _i$1 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$1]);
				if (!$clone(cp.Project(axis$1), Projection).Overlapping($clone(other.Project(axis$1), Projection))) {
					return Vector.nil;
				}
				overlap$1 = $clone(cp.Project(axis$1), Projection).Overlap($clone(other.Project(axis$1), Projection));
				if (smallest.Magnitude() > overlap$1) {
					smallest = axis$1.Scale(overlap$1);
				}
				_i$1++;
			}
		}
		(0 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 0] = (0 >= smallest.$length ? ($throwRuntimeError("index out of range"), undefined) : smallest.$array[smallest.$offset + 0]));
		(1 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 1] = (1 >= smallest.$length ? ($throwRuntimeError("index out of range"), undefined) : smallest.$array[smallest.$offset + 1]));
		return delta;
	};
	ConvexPolygon.prototype.calculateMTV = function(contactSet, otherShape) { return this.$val.calculateMTV(contactSet, otherShape); };
	ConvexPolygon.ptr.prototype.ContainedBy = function(otherShape) {
		var _i, _i$1, _ref, _ref$1, _ref$2, axis, axis$1, cp, other, otherShape;
		cp = this;
		_ref = otherShape;
		if ($assertType(_ref, ptrType$6, true)[1]) {
			other = _ref.$val;
			_ref$1 = cp.SATAxes();
			_i = 0;
			while (true) {
				if (!(_i < _ref$1.$length)) { break; }
				axis = ((_i < 0 || _i >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i]);
				if (!$clone(cp.Project(axis), Projection).IsInside($clone(other.Project(axis), Projection))) {
					return false;
				}
				_i++;
			}
			_ref$2 = other.SATAxes();
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$2.$length)) { break; }
				axis$1 = ((_i$1 < 0 || _i$1 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$1]);
				if (!$clone(cp.Project(axis$1), Projection).IsInside($clone(other.Project(axis$1), Projection))) {
					return false;
				}
				_i$1++;
			}
		}
		return true;
	};
	ConvexPolygon.prototype.ContainedBy = function(otherShape) { return this.$val.ContainedBy(otherShape); };
	NewRectangle = function(x, y, w, h) {
		var h, w, x, y;
		return NewConvexPolygon(new sliceType([x, y, x + w, y, x + w, y + h, x, y + h]));
	};
	$pkg.NewRectangle = NewRectangle;
	NewCircle = function(x, y, radius) {
		var circle, radius, x, y;
		circle = new Circle.ptr(x, y, radius);
		return circle;
	};
	$pkg.NewCircle = NewCircle;
	Circle.ptr.prototype.Clone = function() {
		var circle;
		circle = this;
		return NewCircle(circle.X, circle.Y, circle.Radius);
	};
	Circle.prototype.Clone = function() { return this.$val.Clone(); };
	Circle.ptr.prototype.Bounds = function() {
		var circle;
		circle = this;
		return [new Vector([circle.X - circle.Radius, circle.Y - circle.Radius]), new Vector([circle.X + circle.Radius, circle.Y + circle.Radius])];
	};
	Circle.prototype.Bounds = function() { return this.$val.Bounds(); };
	Circle.ptr.prototype.Intersection = function(dx, dy, other) {
		var _i, _ref, _ref$1, circle, contactSet, dist, dx, dy, other, ox, oy, point, shape, shape$1, x, x$1, x$2, x$3;
		circle = this;
		contactSet = ptrType$7.nil;
		ox = circle.X;
		oy = circle.Y;
		circle.X = circle.X + (dx);
		circle.Y = circle.Y + (dy);
		_ref = other;
		if ($assertType(_ref, ptrType$6, true)[1]) {
			shape = _ref.$val;
			contactSet = shape.Intersection(-dx, -dy, circle);
			if (!(contactSet === ptrType$7.nil)) {
				contactSet.MTV = contactSet.MTV.Scale(-1);
			}
		} else if ($assertType(_ref, ptrType$5, true)[1]) {
			shape$1 = _ref.$val;
			contactSet = NewContactSet();
			contactSet.Points = circle.IntersectionPointsCircle(shape$1);
			if (contactSet.Points.$length === 0) {
				return ptrType$7.nil;
			}
			contactSet.MTV = new Vector([circle.X - shape$1.X, circle.Y - shape$1.Y]);
			dist = contactSet.MTV.Magnitude();
			contactSet.MTV = contactSet.MTV.Unit().Scale(circle.Radius + shape$1.Radius - dist);
			_ref$1 = contactSet.Points;
			_i = 0;
			while (true) {
				if (!(_i < _ref$1.$length)) { break; }
				point = ((_i < 0 || _i >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i]);
				contactSet.Center = contactSet.Center.Add(new sliceType$4([point]));
				_i++;
			}
			(x$1 = contactSet.Center, (0 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 0] = (x = contactSet.Center, (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0])) / ((contactSet.Points.$length))));
			(x$3 = contactSet.Center, (1 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 1] = (x$2 = contactSet.Center, (1 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 1])) / ((contactSet.Points.$length))));
		}
		circle.X = ox;
		circle.Y = oy;
		return contactSet;
	};
	Circle.prototype.Intersection = function(dx, dy, other) { return this.$val.Intersection(dx, dy, other); };
	Circle.ptr.prototype.Move = function(x, y) {
		var circle, x, y;
		circle = this;
		circle.X = circle.X + (x);
		circle.Y = circle.Y + (y);
	};
	Circle.prototype.Move = function(x, y) { return this.$val.Move(x, y); };
	Circle.ptr.prototype.MoveVec = function(vec) {
		var circle, vec;
		circle = this;
		circle.X = circle.X + (vec.X());
		circle.Y = circle.Y + (vec.Y());
	};
	Circle.prototype.MoveVec = function(vec) { return this.$val.MoveVec(vec); };
	Circle.ptr.prototype.SetPosition = function(x, y) {
		var circle, x, y;
		circle = this;
		circle.X = x;
		circle.Y = y;
	};
	Circle.prototype.SetPosition = function(x, y) { return this.$val.SetPosition(x, y); };
	Circle.ptr.prototype.SetPositionVec = function(vec) {
		var circle, vec;
		circle = this;
		circle.X = vec.X();
		circle.Y = vec.Y();
	};
	Circle.prototype.SetPositionVec = function(vec) { return this.$val.SetPositionVec(vec); };
	Circle.ptr.prototype.Position = function() {
		var circle;
		circle = this;
		return [circle.X, circle.Y];
	};
	Circle.prototype.Position = function() { return this.$val.Position(); };
	Circle.ptr.prototype.PointInside = function(point) {
		var circle, point;
		circle = this;
		return point.Sub(new sliceType$4([new Vector([circle.X, circle.Y])])).Magnitude() <= circle.Radius;
	};
	Circle.prototype.PointInside = function(point) { return this.$val.PointInside(point); };
	Circle.ptr.prototype.IntersectionPointsCircle = function(other) {
		var a, circle, d, h, other, x2, y2;
		circle = this;
		d = math.Sqrt(math.Pow(other.X - circle.X, 2) + math.Pow(other.Y - circle.Y, 2));
		if (d > circle.Radius + other.Radius || d < math.Abs(circle.Radius - other.Radius) || (d === 0) && (circle.Radius === other.Radius)) {
			return sliceType$4.nil;
		}
		a = (math.Pow(circle.Radius, 2) - math.Pow(other.Radius, 2) + math.Pow(d, 2)) / (2 * d);
		h = math.Sqrt(math.Pow(circle.Radius, 2) - math.Pow(a, 2));
		x2 = circle.X + a * (other.X - circle.X) / d;
		y2 = circle.Y + a * (other.Y - circle.Y) / d;
		return new sliceType$4([new Vector([x2 + h * (other.Y - circle.Y) / d, y2 - h * (other.X - circle.X) / d]), new Vector([x2 - h * (other.Y - circle.Y) / d, y2 + h * (other.X - circle.X) / d])]);
	};
	Circle.prototype.IntersectionPointsCircle = function(other) { return this.$val.IntersectionPointsCircle(other); };
	Projection.ptr.prototype.Overlapping = function(other) {
		var other, projection;
		projection = this;
		return $clone(projection, Projection).Overlap($clone(other, Projection)) > 0;
	};
	Projection.prototype.Overlapping = function(other) { return this.$val.Overlapping(other); };
	Projection.ptr.prototype.Overlap = function(other) {
		var other, projection;
		projection = this;
		return math.Min(projection.Max, other.Max) - math.Max(projection.Min, other.Min);
	};
	Projection.prototype.Overlap = function(other) { return this.$val.Overlap(other); };
	Projection.ptr.prototype.IsInside = function(other) {
		var other, projection;
		projection = this;
		return projection.Min >= other.Min && projection.Max <= other.Max;
	};
	Projection.prototype.IsInside = function(other) { return this.$val.IsInside(other); };
	NewRingBuffer = function(n) {
		var n;
		return new RingBuffer.ptr(0, 0, 0, 0, n, 0, $makeSlice(sliceType$6, n));
	};
	$pkg.NewRingBuffer = NewRingBuffer;
	RingBuffer.ptr.prototype.DryPut = function() {
		var rb;
		rb = this;
		while (true) {
			if (!(0 < rb.Cnt && rb.Cnt >= rb.N)) { break; }
			rb.Pop();
		}
		rb.EdFrameId = rb.EdFrameId + (1) >> 0;
		rb.Cnt = rb.Cnt + (1) >> 0;
		rb.Ed = rb.Ed + (1) >> 0;
		if (rb.Ed >= rb.N) {
			rb.Ed = rb.Ed - (rb.N) >> 0;
		}
	};
	RingBuffer.prototype.DryPut = function() { return this.$val.DryPut(); };
	RingBuffer.ptr.prototype.Put = function(pItem) {
		var pItem, rb, x, x$1;
		rb = this;
		while (true) {
			if (!(0 < rb.Cnt && rb.Cnt >= rb.N)) { break; }
			rb.Pop();
		}
		(x = rb.Eles, x$1 = rb.Ed, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1] = pItem));
		rb.EdFrameId = rb.EdFrameId + (1) >> 0;
		rb.Cnt = rb.Cnt + (1) >> 0;
		rb.Ed = rb.Ed + (1) >> 0;
		if (rb.Ed >= rb.N) {
			rb.Ed = rb.Ed - (rb.N) >> 0;
		}
	};
	RingBuffer.prototype.Put = function(pItem) { return this.$val.Put(pItem); };
	RingBuffer.ptr.prototype.Pop = function() {
		var pItem, rb, x, x$1;
		rb = this;
		if (0 === rb.Cnt) {
			return $ifaceNil;
		}
		pItem = (x = rb.Eles, x$1 = rb.St, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1]));
		rb.StFrameId = rb.StFrameId + (1) >> 0;
		rb.Cnt = rb.Cnt - (1) >> 0;
		rb.St = rb.St + (1) >> 0;
		if (rb.St >= rb.N) {
			rb.St = rb.St - (rb.N) >> 0;
		}
		return pItem;
	};
	RingBuffer.prototype.Pop = function() { return this.$val.Pop(); };
	RingBuffer.ptr.prototype.GetArrIdxByOffset = function(offsetFromSt) {
		var arrIdx, offsetFromSt, rb;
		rb = this;
		if ((0 === rb.Cnt) || 0 > offsetFromSt) {
			return -1;
		}
		arrIdx = rb.St + offsetFromSt >> 0;
		if (rb.St < rb.Ed) {
			if (rb.St <= arrIdx && arrIdx < rb.Ed) {
				return arrIdx;
			}
		} else {
			if (arrIdx >= rb.N) {
				arrIdx = arrIdx - (rb.N) >> 0;
			}
			if (arrIdx >= rb.St || arrIdx < rb.Ed) {
				return arrIdx;
			}
		}
		return -1;
	};
	RingBuffer.prototype.GetArrIdxByOffset = function(offsetFromSt) { return this.$val.GetArrIdxByOffset(offsetFromSt); };
	RingBuffer.ptr.prototype.GetByOffset = function(offsetFromSt) {
		var arrIdx, offsetFromSt, rb, x;
		rb = this;
		arrIdx = rb.GetArrIdxByOffset(offsetFromSt);
		if (-1 === arrIdx) {
			return $ifaceNil;
		}
		return (x = rb.Eles, ((arrIdx < 0 || arrIdx >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + arrIdx]));
	};
	RingBuffer.prototype.GetByOffset = function(offsetFromSt) { return this.$val.GetByOffset(offsetFromSt); };
	RingBuffer.ptr.prototype.GetByFrameId = function(frameId) {
		var frameId, rb;
		rb = this;
		if (frameId >= rb.EdFrameId || frameId < rb.StFrameId) {
			return $ifaceNil;
		}
		return rb.GetByOffset(frameId - rb.StFrameId >> 0);
	};
	RingBuffer.prototype.GetByFrameId = function(frameId) { return this.$val.GetByFrameId(frameId); };
	RingBuffer.ptr.prototype.SetByFrameId = function(pItem, frameId) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, arrIdx, frameId, oldEdFrameId, oldStFrameId, pItem, rb, ret, x;
		rb = this;
		_tmp = rb.StFrameId;
		_tmp$1 = rb.EdFrameId;
		oldStFrameId = _tmp;
		oldEdFrameId = _tmp$1;
		if (frameId < oldStFrameId) {
			return [2, oldStFrameId, oldEdFrameId];
		}
		if (oldEdFrameId > frameId) {
			arrIdx = rb.GetArrIdxByOffset(frameId - rb.StFrameId >> 0);
			if (!((-1 === arrIdx))) {
				(x = rb.Eles, ((arrIdx < 0 || arrIdx >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + arrIdx] = pItem));
				return [0, oldStFrameId, oldEdFrameId];
			}
		}
		ret = 0;
		if (oldEdFrameId < frameId) {
			_tmp$2 = 0;
			_tmp$3 = 0;
			rb.St = _tmp$2;
			rb.Ed = _tmp$3;
			_tmp$4 = frameId;
			_tmp$5 = frameId;
			rb.StFrameId = _tmp$4;
			rb.EdFrameId = _tmp$5;
			rb.Cnt = 0;
			ret = 1;
		}
		rb.Put(pItem);
		return [ret, oldStFrameId, oldEdFrameId];
	};
	RingBuffer.prototype.SetByFrameId = function(pItem, frameId) { return this.$val.SetByFrameId(pItem, frameId); };
	RingBuffer.ptr.prototype.Clear = function() {
		var rb;
		rb = this;
		while (true) {
			if (!(0 < rb.Cnt)) { break; }
			rb.Pop();
		}
		rb.St = 0;
		rb.Ed = 0;
		rb.StFrameId = 0;
		rb.EdFrameId = 0;
	};
	RingBuffer.prototype.Clear = function() { return this.$val.Clear(); };
	RingBuffer.ptr.prototype.GetStFrameId = function() {
		var rb;
		rb = this;
		return rb.StFrameId;
	};
	RingBuffer.prototype.GetStFrameId = function() { return this.$val.GetStFrameId(); };
	RingBuffer.ptr.prototype.GetEdFrameId = function() {
		var rb;
		rb = this;
		return rb.EdFrameId;
	};
	RingBuffer.prototype.GetEdFrameId = function() { return this.$val.GetEdFrameId(); };
	RingBuffer.ptr.prototype.GetCnt = function() {
		var rb;
		rb = this;
		return rb.Cnt;
	};
	RingBuffer.prototype.GetCnt = function() { return this.$val.GetCnt(); };
	NewObjectSingleTag = function(x, y, w, h, tag) {
		var h, o, tag, w, x, y;
		o = new Object.ptr($ifaceNil, ptrType$1.nil, x, y, w, h, NewRingBuffer(512), $ifaceNil, $makeMap(ptrType$2.keyFor, []), new sliceType$7([tag]));
		return o;
	};
	$pkg.NewObjectSingleTag = NewObjectSingleTag;
	NewObject = function(x, y, w, h, tags) {
		var h, o, tags, w, x, y;
		o = new Object.ptr($ifaceNil, ptrType$1.nil, x, y, w, h, NewRingBuffer(512), $ifaceNil, $makeMap(ptrType$2.keyFor, []), new sliceType$7([]));
		if (tags.$length > 0) {
			o.AddTags(tags);
		}
		return o;
	};
	$pkg.NewObject = NewObject;
	Object.ptr.prototype.GetData = function() {
		var obj;
		obj = this;
		return obj.Data;
	};
	Object.prototype.GetData = function() { return this.$val.GetData(); };
	Object.ptr.prototype.GetShape = function() {
		var obj;
		obj = this;
		return (obj.$ptr_Shape || (obj.$ptr_Shape = new ptrType$8(function() { return this.$target.Shape; }, function($v) { this.$target.Shape = $v; }, obj)));
	};
	Object.prototype.GetShape = function() { return this.$val.GetShape(); };
	Object.ptr.prototype.Position = function() {
		var obj;
		obj = this;
		return [obj.X, obj.Y];
	};
	Object.prototype.Position = function() { return this.$val.Position(); };
	Object.ptr.prototype.Clone = function() {
		var {_entry, _i, _keys, _r, _ref, k, newObj, obj, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		obj = this;
		newObj = NewObject(obj.X, obj.Y, obj.W, obj.H, obj.Tags());
		newObj.Data = obj.Data;
		/* */ if (!($interfaceIsEqual(obj.Shape, $ifaceNil))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!($interfaceIsEqual(obj.Shape, $ifaceNil))) { */ case 1:
			_r = obj.Shape.Clone(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$r = newObj.SetShape(_r); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		_ref = obj.ignoreList;
		_i = 0;
		_keys = $keys(_ref);
		while (true) {
			if (!(_i < _keys.length)) { break; }
			_entry = _ref[_keys[_i]];
			if (_entry === undefined) {
				_i++;
				continue;
			}
			k = _entry.k;
			newObj.AddToIgnoreList(k);
			_i++;
		}
		$s = -1; return newObj;
		/* */ } return; } var $f = {$blk: Object.ptr.prototype.Clone, $c: true, $r, _entry, _i, _keys, _r, _ref, k, newObj, obj, $s};return $f;
	};
	Object.prototype.Clone = function() { return this.$val.Clone(); };
	Object.ptr.prototype.Update = function() {
		var {_tuple, c, cx, cy, ex, ey, obj, space, x, y, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		obj = this;
		if (!(obj.Space === ptrType$1.nil)) {
			space = obj.Space;
			obj.Space.RemoveSingle(obj);
			obj.Space = space;
			_tuple = obj.BoundsToSpace(0, 0);
			cx = _tuple[0];
			cy = _tuple[1];
			ex = _tuple[2];
			ey = _tuple[3];
			y = cy;
			while (true) {
				if (!(y <= ey)) { break; }
				x = cx;
				while (true) {
					if (!(x <= ex)) { break; }
					c = obj.Space.Cell(x, y);
					if (!(c === ptrType.nil)) {
						c.register(obj);
						obj.TouchingCells.Put(c);
					}
					x = x + (1) >> 0;
				}
				y = y + (1) >> 0;
			}
		}
		/* */ if (!($interfaceIsEqual(obj.Shape, $ifaceNil))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!($interfaceIsEqual(obj.Shape, $ifaceNil))) { */ case 1:
			$r = obj.Shape.SetPosition(obj.X, obj.Y); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Object.ptr.prototype.Update, $c: true, $r, _tuple, c, cx, cy, ex, ey, obj, space, x, y, $s};return $f;
	};
	Object.prototype.Update = function() { return this.$val.Update(); };
	Object.ptr.prototype.AddTags = function(tags) {
		var obj, tags;
		obj = this;
		obj.tags = $appendSlice(obj.tags, tags);
	};
	Object.prototype.AddTags = function(tags) { return this.$val.AddTags(tags); };
	Object.ptr.prototype.RemoveTags = function(tags) {
		var _i, _i$1, _ref, _ref$1, i, obj, t, tag, tags;
		obj = this;
		_ref = tags;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			tag = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_ref$1 = obj.tags;
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				i = _i$1;
				t = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
				if (t === tag) {
					obj.tags = $appendSlice($subslice(obj.tags, 0, i), $subslice(obj.tags, (i + 1 >> 0)));
					break;
				}
				_i$1++;
			}
			_i++;
		}
	};
	Object.prototype.RemoveTags = function(tags) { return this.$val.RemoveTags(tags); };
	Object.ptr.prototype.HasTags = function(tags) {
		var _i, _i$1, _ref, _ref$1, obj, t, tag, tags;
		obj = this;
		_ref = tags;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			tag = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_ref$1 = obj.tags;
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				t = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
				if (t === tag) {
					return true;
				}
				_i$1++;
			}
			_i++;
		}
		return false;
	};
	Object.prototype.HasTags = function(tags) { return this.$val.HasTags(tags); };
	Object.ptr.prototype.Tags = function() {
		var obj;
		obj = this;
		return $appendSlice(new sliceType$7([]), obj.tags);
	};
	Object.prototype.Tags = function() { return this.$val.Tags(); };
	Object.ptr.prototype.SetShape = function(shape) {
		var {obj, shape, $s, $r, $c} = $restore(this, {shape});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		obj = this;
		/* */ if (!($interfaceIsEqual(obj.Shape, shape))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!($interfaceIsEqual(obj.Shape, shape))) { */ case 1:
			obj.Shape = shape;
			$r = obj.Update(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Object.ptr.prototype.SetShape, $c: true, $r, obj, shape, $s};return $f;
	};
	Object.prototype.SetShape = function(shape) { return this.$val.SetShape(shape); };
	Object.ptr.prototype.BoundsToSpace = function(dx, dy) {
		var _tuple, _tuple$1, cx, cy, dx, dy, ex, ey, obj;
		obj = this;
		_tuple = obj.Space.WorldToSpace(obj.X + dx, obj.Y + dy);
		cx = _tuple[0];
		cy = _tuple[1];
		_tuple$1 = obj.Space.WorldToSpace(obj.X + obj.W + dx - 1, obj.Y + obj.H + dy - 1);
		ex = _tuple$1[0];
		ey = _tuple$1[1];
		return [cx, cy, ex, ey];
	};
	Object.prototype.BoundsToSpace = function(dx, dy) { return this.$val.BoundsToSpace(dx, dy); };
	Object.ptr.prototype.SharesCells = function(other) {
		var cell, i, obj, other, rb;
		obj = this;
		rb = obj.TouchingCells;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			cell = $assertType(rb.GetByFrameId(i), ptrType);
			if (cell.Contains(other)) {
				return true;
			}
			i = i + (1) >> 0;
		}
		return false;
	};
	Object.prototype.SharesCells = function(other) { return this.$val.SharesCells(other); };
	Object.ptr.prototype.SharesCellsTags = function(tags) {
		var cell, i, obj, rb, tags;
		obj = this;
		rb = obj.TouchingCells;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			cell = $assertType(rb.GetByFrameId(i), ptrType);
			if (cell.ContainsTags(tags)) {
				return true;
			}
			i = i + (1) >> 0;
		}
		return false;
	};
	Object.prototype.SharesCellsTags = function(tags) { return this.$val.SharesCellsTags(tags); };
	Object.ptr.prototype.Center = function() {
		var obj;
		obj = this;
		return [obj.X + (obj.W / 2), obj.Y + (obj.H / 2)];
	};
	Object.prototype.Center = function() { return this.$val.Center(); };
	Object.ptr.prototype.SetCenter = function(x, y) {
		var obj, x, y;
		obj = this;
		obj.X = x - (obj.W / 2);
		obj.Y = y - (obj.H / 2);
	};
	Object.prototype.SetCenter = function(x, y) { return this.$val.SetCenter(x, y); };
	Object.ptr.prototype.CellPosition = function() {
		var _tuple, obj;
		obj = this;
		_tuple = obj.Center();
		return obj.Space.WorldToSpace(_tuple[0], _tuple[1]);
	};
	Object.prototype.CellPosition = function() { return this.$val.CellPosition(); };
	Object.ptr.prototype.SetRight = function(x) {
		var obj, x;
		obj = this;
		obj.X = x - obj.W;
	};
	Object.prototype.SetRight = function(x) { return this.$val.SetRight(x); };
	Object.ptr.prototype.SetBottom = function(y) {
		var obj, y;
		obj = this;
		obj.Y = y - obj.H;
	};
	Object.prototype.SetBottom = function(y) { return this.$val.SetBottom(y); };
	Object.ptr.prototype.Bottom = function() {
		var obj;
		obj = this;
		return obj.Y + obj.H;
	};
	Object.prototype.Bottom = function() { return this.$val.Bottom(); };
	Object.ptr.prototype.Right = function() {
		var obj;
		obj = this;
		return obj.X + obj.W;
	};
	Object.prototype.Right = function() { return this.$val.Right(); };
	Object.ptr.prototype.SetBounds = function(topLeft, bottomRight) {
		var bottomRight, obj, topLeft;
		obj = this;
		obj.X = (0 >= topLeft.$length ? ($throwRuntimeError("index out of range"), undefined) : topLeft.$array[topLeft.$offset + 0]);
		obj.Y = (1 >= topLeft.$length ? ($throwRuntimeError("index out of range"), undefined) : topLeft.$array[topLeft.$offset + 1]);
		obj.W = (0 >= bottomRight.$length ? ($throwRuntimeError("index out of range"), undefined) : bottomRight.$array[bottomRight.$offset + 0]) - obj.X;
		obj.H = (1 >= bottomRight.$length ? ($throwRuntimeError("index out of range"), undefined) : bottomRight.$array[bottomRight.$offset + 1]) - obj.Y;
	};
	Object.prototype.SetBounds = function(topLeft, bottomRight) { return this.$val.SetBounds(topLeft, bottomRight); };
	Object.ptr.prototype.CheckAllWithHolder = function(dx, dy, cc) {
		var _entry, _entry$1, _entry$2, _key, _key$1, _tuple, _tuple$1, _tuple$2, added, added$1, c, cc, cellsAdded, cx, cy, dx, dy, ex, ey, i, ignored, o, obj, objectsAdded, rb, x, y;
		obj = this;
		if (obj.Space === ptrType$1.nil) {
			return false;
		}
		cc.Clear();
		cc.checkingObject = obj;
		if (dx < 0) {
			dx = math.Min(dx, -1);
		} else if (dx > 0) {
			dx = math.Max(dx, 1);
		}
		if (dy < 0) {
			dy = math.Min(dy, -1);
		} else if (dy > 0) {
			dy = math.Max(dy, 1);
		}
		cc.dx = dx;
		cc.dy = dy;
		_tuple = obj.BoundsToSpace(dx, dy);
		cx = _tuple[0];
		cy = _tuple[1];
		ex = _tuple[2];
		ey = _tuple[3];
		objectsAdded = $makeMap(ptrType$2.keyFor, []);
		cellsAdded = $makeMap(ptrType.keyFor, []);
		y = cy;
		while (true) {
			if (!(y <= ey)) { break; }
			x = cx;
			while (true) {
				if (!(x <= ex)) { break; }
				c = obj.Space.Cell(x, y);
				if (!(c === ptrType.nil)) {
					rb = c.Objects;
					i = rb.StFrameId;
					while (true) {
						if (!(i < rb.EdFrameId)) { break; }
						o = $assertType(rb.GetByFrameId(i), ptrType$2);
						ignored = (_entry = obj.ignoreList[ptrType$2.keyFor(o)], _entry !== undefined ? _entry.v : false);
						if (o === obj || ignored) {
							i = i + (1) >> 0;
							continue;
						}
						_tuple$1 = (_entry$1 = objectsAdded[ptrType$2.keyFor(o)], _entry$1 !== undefined ? [_entry$1.v, true] : [false, false]);
						added = _tuple$1[1];
						if (!added) {
							cc.Objects.Put(o);
							_key = o; (objectsAdded || $throwRuntimeError("assignment to entry in nil map"))[ptrType$2.keyFor(_key)] = { k: _key, v: true };
							_tuple$2 = (_entry$2 = cellsAdded[ptrType.keyFor(c)], _entry$2 !== undefined ? [_entry$2.v, true] : [false, false]);
							added$1 = _tuple$2[1];
							if (!added$1) {
								cc.Cells.Put(c);
								_key$1 = c; (cellsAdded || $throwRuntimeError("assignment to entry in nil map"))[ptrType.keyFor(_key$1)] = { k: _key$1, v: true };
							}
							i = i + (1) >> 0;
							continue;
						}
						i = i + (1) >> 0;
					}
				}
				x = x + (1) >> 0;
			}
			y = y + (1) >> 0;
		}
		if (0 >= cc.Objects.Cnt) {
			return false;
		}
		return true;
	};
	Object.prototype.CheckAllWithHolder = function(dx, dy, cc) { return this.$val.CheckAllWithHolder(dx, dy, cc); };
	Object.ptr.prototype.Overlaps = function(other) {
		var obj, other;
		obj = this;
		return other.X <= obj.X + obj.W && other.X + other.W >= obj.X && other.Y <= obj.Y + obj.H && other.Y + other.H >= obj.Y;
	};
	Object.prototype.Overlaps = function(other) { return this.$val.Overlaps(other); };
	Object.ptr.prototype.AddToIgnoreList = function(ignoreObj) {
		var _key, ignoreObj, obj;
		obj = this;
		_key = ignoreObj; (obj.ignoreList || $throwRuntimeError("assignment to entry in nil map"))[ptrType$2.keyFor(_key)] = { k: _key, v: true };
	};
	Object.prototype.AddToIgnoreList = function(ignoreObj) { return this.$val.AddToIgnoreList(ignoreObj); };
	Object.ptr.prototype.RemoveFromIgnoreList = function(ignoreObj) {
		var ignoreObj, obj;
		obj = this;
		delete obj.ignoreList[ptrType$2.keyFor(ignoreObj)];
	};
	Object.prototype.RemoveFromIgnoreList = function(ignoreObj) { return this.$val.RemoveFromIgnoreList(ignoreObj); };
	axpyUnitaryTo = function(dst, alpha, x, y) {
		var _i, _ref, alpha, dim, dst, i, v, x, y;
		dim = y.$length;
		_ref = x;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (i === dim) {
				return;
			}
			((i < 0 || i >= dst.$length) ? ($throwRuntimeError("index out of range"), undefined) : dst.$array[dst.$offset + i] = alpha * v + ((i < 0 || i >= y.$length) ? ($throwRuntimeError("index out of range"), undefined) : y.$array[y.$offset + i]));
			_i++;
		}
	};
	scalUnitaryTo = function(dst, alpha, x) {
		var _i, _ref, alpha, dst, i, x;
		_ref = x;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			((i < 0 || i >= dst.$length) ? ($throwRuntimeError("index out of range"), undefined) : dst.$array[dst.$offset + i] = ((i < 0 || i >= dst.$length) ? ($throwRuntimeError("index out of range"), undefined) : dst.$array[dst.$offset + i]) * (alpha));
			_i++;
		}
	};
	NewCollision = function() {
		return new Collision.ptr(ptrType$2.nil, 0, 0, NewRingBuffer(16), NewRingBuffer(16));
	};
	$pkg.NewCollision = NewCollision;
	Collision.ptr.prototype.Clear = function() {
		var cc;
		cc = this;
		cc.checkingObject = ptrType$2.nil;
		cc.dx = 0;
		cc.dy = 0;
		cc.Objects.Clear();
		cc.Cells.Clear();
	};
	Collision.prototype.Clear = function() { return this.$val.Clear(); };
	Collision.ptr.prototype.PopFirstCollidedObject = function() {
		var cc;
		cc = this;
		if (0 >= cc.Objects.Cnt) {
			return ptrType$2.nil;
		}
		return $assertType(cc.Objects.Pop(), ptrType$2);
	};
	Collision.prototype.PopFirstCollidedObject = function() { return this.$val.PopFirstCollidedObject(); };
	Collision.ptr.prototype.HasTags = function(tags) {
		var cc, i, o, rb, tags;
		cc = this;
		rb = cc.Objects;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			o = $assertType(rb.GetByFrameId(i), ptrType$2);
			if (o === cc.checkingObject) {
				i = i + (1) >> 0;
				continue;
			}
			if (o.HasTags(tags)) {
				return true;
			}
			i = i + (1) >> 0;
		}
		return false;
	};
	Collision.prototype.HasTags = function(tags) { return this.$val.HasTags(tags); };
	Collision.ptr.prototype.ObjectsByTags = function(tags) {
		var cc, i, o, objects, rb, tags;
		cc = this;
		objects = new sliceType$3([]);
		rb = cc.Objects;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			o = $assertType(rb.GetByFrameId(i), ptrType$2);
			if (o === cc.checkingObject) {
				i = i + (1) >> 0;
				continue;
			}
			if (o.HasTags(tags)) {
				objects = $append(objects, o);
			}
			i = i + (1) >> 0;
		}
		return objects;
	};
	Collision.prototype.ObjectsByTags = function(tags) { return this.$val.ObjectsByTags(tags); };
	Collision.ptr.prototype.ContactWithObject = function(object) {
		var cc, delta, object;
		cc = this;
		delta = new Vector([0, 0]);
		if (cc.dx < 0) {
			(0 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 0] = object.X + object.W - cc.checkingObject.X);
		} else if (cc.dx > 0) {
			(0 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 0] = object.X - cc.checkingObject.W - cc.checkingObject.X);
		}
		if (cc.dy < 0) {
			(1 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 1] = object.Y + object.H - cc.checkingObject.Y);
		} else if (cc.dy > 0) {
			(1 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 1] = object.Y - cc.checkingObject.H - cc.checkingObject.Y);
		}
		return delta;
	};
	Collision.prototype.ContactWithObject = function(object) { return this.$val.ContactWithObject(object); };
	Collision.ptr.prototype.ContactWithCell = function(cell) {
		var cc, cell, cx, cy, delta;
		cc = this;
		delta = new Vector([0, 0]);
		cx = (($imul(cell.X, cc.checkingObject.Space.CellWidth)));
		cy = (($imul(cell.Y, cc.checkingObject.Space.CellHeight)));
		if (cc.dx < 0) {
			(0 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 0] = cx + (cc.checkingObject.Space.CellWidth) - cc.checkingObject.X);
		} else if (cc.dx > 0) {
			(0 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 0] = cx - cc.checkingObject.W - cc.checkingObject.X);
		}
		if (cc.dy < 0) {
			(1 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 1] = cy + (cc.checkingObject.Space.CellHeight) - cc.checkingObject.Y);
		} else if (cc.dy > 0) {
			(1 >= delta.$length ? ($throwRuntimeError("index out of range"), undefined) : delta.$array[delta.$offset + 1] = cy - cc.checkingObject.H - cc.checkingObject.Y);
		}
		return delta;
	};
	Collision.prototype.ContactWithCell = function(cell) { return this.$val.ContactWithCell(cell); };
	Collision.ptr.prototype.SlideAgainstCell = function(cell, avoidTags) {
		var _tuple, _tuple$1, avoidTags, cc, ccX, ccY, cell, collidingCell, diffX, diffY, down, hX, hY, left, oX, oY, right, slide, sp, up;
		cc = this;
		sp = cc.checkingObject.Space;
		collidingCell = $assertType(cc.Cells.GetByFrameId(cc.Cells.StFrameId), ptrType);
		_tuple = sp.SpaceToWorld(collidingCell.X, collidingCell.Y);
		ccX = _tuple[0];
		ccY = _tuple[1];
		hX = (sp.CellWidth) / 2;
		hY = (sp.CellHeight) / 2;
		ccX = ccX + (hX);
		ccY = ccY + (hY);
		_tuple$1 = cc.checkingObject.Center();
		oX = _tuple$1[0];
		oY = _tuple$1[1];
		diffX = oX - ccX;
		diffY = oY - ccY;
		left = sp.Cell(collidingCell.X - 1 >> 0, collidingCell.Y);
		right = sp.Cell(collidingCell.X + 1 >> 0, collidingCell.Y);
		up = sp.Cell(collidingCell.X, collidingCell.Y - 1 >> 0);
		down = sp.Cell(collidingCell.X, collidingCell.Y + 1 >> 0);
		slide = new Vector([0, 0]);
		if (!((cc.dy === 0))) {
			if (diffX > 0 && (right === ptrType.nil || !right.ContainsTags(avoidTags))) {
				(0 >= slide.$length ? ($throwRuntimeError("index out of range"), undefined) : slide.$array[slide.$offset + 0] = ccX + hX - cc.checkingObject.X);
			} else if (diffX < 0 && (left === ptrType.nil || !left.ContainsTags(avoidTags))) {
				(0 >= slide.$length ? ($throwRuntimeError("index out of range"), undefined) : slide.$array[slide.$offset + 0] = ccX - hX - (cc.checkingObject.X + cc.checkingObject.W));
			} else {
				return Vector.nil;
			}
		}
		if (!((cc.dx === 0))) {
			if (diffY > 0 && (down === ptrType.nil || !down.ContainsTags(avoidTags))) {
				(1 >= slide.$length ? ($throwRuntimeError("index out of range"), undefined) : slide.$array[slide.$offset + 1] = ccY + hY - cc.checkingObject.Y);
			} else if (diffY < 0 && (up === ptrType.nil || !up.ContainsTags(avoidTags))) {
				(1 >= slide.$length ? ($throwRuntimeError("index out of range"), undefined) : slide.$array[slide.$offset + 1] = ccY - hY - (cc.checkingObject.Y + cc.checkingObject.H));
			} else {
				return Vector.nil;
			}
		}
		return slide;
	};
	Collision.prototype.SlideAgainstCell = function(cell, avoidTags) { return this.$val.SlideAgainstCell(cell, avoidTags); };
	newCell = function(x, y) {
		var x, y;
		return new Cell.ptr(x, y, NewRingBuffer(16));
	};
	Cell.ptr.prototype.register = function(obj) {
		var cell, obj;
		cell = this;
		if (!cell.Contains(obj)) {
			cell.Objects.Put(obj);
		}
	};
	Cell.prototype.register = function(obj) { return this.$val.register(obj); };
	Cell.ptr.prototype.unregister = function(obj) {
		var cell, i, o, obj, rb;
		cell = this;
		rb = cell.Objects;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			o = $assertType(rb.GetByFrameId(i), ptrType$2);
			if (o === obj) {
				rb.SetByFrameId(rb.GetByFrameId(rb.StFrameId), i);
				rb.Pop();
				break;
			}
			i = i + (1) >> 0;
		}
	};
	Cell.prototype.unregister = function(obj) { return this.$val.unregister(obj); };
	Cell.ptr.prototype.Contains = function(obj) {
		var cell, i, o, obj, rb;
		cell = this;
		rb = cell.Objects;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			o = $assertType(rb.GetByFrameId(i), ptrType$2);
			if (o === obj) {
				return true;
			}
			i = i + (1) >> 0;
		}
		return false;
	};
	Cell.prototype.Contains = function(obj) { return this.$val.Contains(obj); };
	Cell.ptr.prototype.ContainsTags = function(tags) {
		var cell, i, o, rb, tags;
		cell = this;
		rb = cell.Objects;
		i = rb.StFrameId;
		while (true) {
			if (!(i < rb.EdFrameId)) { break; }
			o = $assertType(rb.GetByFrameId(i), ptrType$2);
			if (o.HasTags(tags)) {
				return true;
			}
			i = i + (1) >> 0;
		}
		return false;
	};
	Cell.prototype.ContainsTags = function(tags) { return this.$val.ContainsTags(tags); };
	Cell.ptr.prototype.Occupied = function() {
		var cell;
		cell = this;
		return 0 < cell.Objects.Cnt;
	};
	Cell.prototype.Occupied = function() { return this.$val.Occupied(); };
	Vector.methods = [{prop: "Clone", name: "Clone", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "Add", name: "Add", pkg: "", typ: $funcType([sliceType$4], [Vector], true)}, {prop: "Sub", name: "Sub", pkg: "", typ: $funcType([sliceType$4], [Vector], true)}, {prop: "Scale", name: "Scale", pkg: "", typ: $funcType([$Float64], [Vector], false)}, {prop: "Equal", name: "Equal", pkg: "", typ: $funcType([Vector], [$Bool], false)}, {prop: "Magnitude", name: "Magnitude", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Magnitude2", name: "Magnitude2", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Unit", name: "Unit", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "Dot", name: "Dot", pkg: "", typ: $funcType([Vector], [$Float64], false)}, {prop: "Cross", name: "Cross", pkg: "", typ: $funcType([Vector], [Vector], false)}, {prop: "Rotate", name: "Rotate", pkg: "", typ: $funcType([$Float64, sliceType$8], [Vector], true)}, {prop: "X", name: "X", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Y", name: "Y", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Z", name: "Z", pkg: "", typ: $funcType([], [$Float64], false)}];
	ptrType$1.methods = [{prop: "AddSingle", name: "AddSingle", pkg: "", typ: $funcType([ptrType$2], [], false)}, {prop: "Add", name: "Add", pkg: "", typ: $funcType([sliceType$3], [], true)}, {prop: "RemoveSingle", name: "RemoveSingle", pkg: "", typ: $funcType([ptrType$2], [], false)}, {prop: "Remove", name: "Remove", pkg: "", typ: $funcType([sliceType$3], [], true)}, {prop: "Objects", name: "Objects", pkg: "", typ: $funcType([], [sliceType$3], false)}, {prop: "Resize", name: "Resize", pkg: "", typ: $funcType([$Int, $Int], [], false)}, {prop: "Cell", name: "Cell", pkg: "", typ: $funcType([$Int, $Int], [ptrType], false)}, {prop: "CheckCells", name: "CheckCells", pkg: "", typ: $funcType([$Int, $Int, $Int, $Int, sliceType$7], [ptrType$2], true)}, {prop: "CheckCellsWorld", name: "CheckCellsWorld", pkg: "", typ: $funcType([$Float64, $Float64, $Float64, $Float64, sliceType$7], [ptrType$2], true)}, {prop: "UnregisterAllObjects", name: "UnregisterAllObjects", pkg: "", typ: $funcType([], [], false)}, {prop: "WorldToSpace", name: "WorldToSpace", pkg: "", typ: $funcType([$Float64, $Float64], [$Int, $Int], false)}, {prop: "SpaceToWorld", name: "SpaceToWorld", pkg: "", typ: $funcType([$Int, $Int], [$Float64, $Float64], false)}, {prop: "Height", name: "Height", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Width", name: "Width", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "CellsInLine", name: "CellsInLine", pkg: "", typ: $funcType([$Int, $Int, $Int, $Int], [sliceType$1], false)}];
	ptrType$4.methods = [{prop: "Project", name: "Project", pkg: "", typ: $funcType([Vector], [Vector], false)}, {prop: "Normal", name: "Normal", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "Vector", name: "Vector", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "IntersectionPointsLine", name: "IntersectionPointsLine", pkg: "", typ: $funcType([ptrType$4], [Vector], false)}, {prop: "IntersectionPointsCircle", name: "IntersectionPointsCircle", pkg: "", typ: $funcType([ptrType$5], [sliceType$4], false)}];
	ptrType$6.methods = [{prop: "GetPointByOffset", name: "GetPointByOffset", pkg: "", typ: $funcType([$Int32], [Vector], false)}, {prop: "Clone", name: "Clone", pkg: "", typ: $funcType([], [Shape], false)}, {prop: "AddPoints", name: "AddPoints", pkg: "", typ: $funcType([sliceType], [], true)}, {prop: "UpdateAsRectangle", name: "UpdateAsRectangle", pkg: "", typ: $funcType([$Float64, $Float64, $Float64, $Float64], [$Bool], false)}, {prop: "Lines", name: "Lines", pkg: "", typ: $funcType([], [sliceType$5], false)}, {prop: "Transformed", name: "Transformed", pkg: "", typ: $funcType([], [sliceType$4], false)}, {prop: "Bounds", name: "Bounds", pkg: "", typ: $funcType([], [Vector, Vector], false)}, {prop: "Position", name: "Position", pkg: "", typ: $funcType([], [$Float64, $Float64], false)}, {prop: "SetPosition", name: "SetPosition", pkg: "", typ: $funcType([$Float64, $Float64], [], false)}, {prop: "SetPositionVec", name: "SetPositionVec", pkg: "", typ: $funcType([Vector], [], false)}, {prop: "Move", name: "Move", pkg: "", typ: $funcType([$Float64, $Float64], [], false)}, {prop: "MoveVec", name: "MoveVec", pkg: "", typ: $funcType([Vector], [], false)}, {prop: "Center", name: "Center", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "Project", name: "Project", pkg: "", typ: $funcType([Vector], [Projection], false)}, {prop: "SATAxes", name: "SATAxes", pkg: "", typ: $funcType([], [sliceType$4], false)}, {prop: "PointInside", name: "PointInside", pkg: "", typ: $funcType([Vector], [$Bool], false)}, {prop: "Intersection", name: "Intersection", pkg: "", typ: $funcType([$Float64, $Float64, Shape], [ptrType$7], false)}, {prop: "calculateMTV", name: "calculateMTV", pkg: "resolv", typ: $funcType([ptrType$7, Shape], [Vector], false)}, {prop: "ContainedBy", name: "ContainedBy", pkg: "", typ: $funcType([Shape], [$Bool], false)}];
	ptrType$7.methods = [{prop: "LeftmostPoint", name: "LeftmostPoint", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "RightmostPoint", name: "RightmostPoint", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "TopmostPoint", name: "TopmostPoint", pkg: "", typ: $funcType([], [Vector], false)}, {prop: "BottommostPoint", name: "BottommostPoint", pkg: "", typ: $funcType([], [Vector], false)}];
	ptrType$5.methods = [{prop: "Clone", name: "Clone", pkg: "", typ: $funcType([], [Shape], false)}, {prop: "Bounds", name: "Bounds", pkg: "", typ: $funcType([], [Vector, Vector], false)}, {prop: "Intersection", name: "Intersection", pkg: "", typ: $funcType([$Float64, $Float64, Shape], [ptrType$7], false)}, {prop: "Move", name: "Move", pkg: "", typ: $funcType([$Float64, $Float64], [], false)}, {prop: "MoveVec", name: "MoveVec", pkg: "", typ: $funcType([Vector], [], false)}, {prop: "SetPosition", name: "SetPosition", pkg: "", typ: $funcType([$Float64, $Float64], [], false)}, {prop: "SetPositionVec", name: "SetPositionVec", pkg: "", typ: $funcType([Vector], [], false)}, {prop: "Position", name: "Position", pkg: "", typ: $funcType([], [$Float64, $Float64], false)}, {prop: "PointInside", name: "PointInside", pkg: "", typ: $funcType([Vector], [$Bool], false)}, {prop: "IntersectionPointsCircle", name: "IntersectionPointsCircle", pkg: "", typ: $funcType([ptrType$5], [sliceType$4], false)}];
	Projection.methods = [{prop: "Overlapping", name: "Overlapping", pkg: "", typ: $funcType([Projection], [$Bool], false)}, {prop: "Overlap", name: "Overlap", pkg: "", typ: $funcType([Projection], [$Float64], false)}, {prop: "IsInside", name: "IsInside", pkg: "", typ: $funcType([Projection], [$Bool], false)}];
	ptrType$3.methods = [{prop: "DryPut", name: "DryPut", pkg: "", typ: $funcType([], [], false)}, {prop: "Put", name: "Put", pkg: "", typ: $funcType([$emptyInterface], [], false)}, {prop: "Pop", name: "Pop", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "GetArrIdxByOffset", name: "GetArrIdxByOffset", pkg: "", typ: $funcType([$Int32], [$Int32], false)}, {prop: "GetByOffset", name: "GetByOffset", pkg: "", typ: $funcType([$Int32], [$emptyInterface], false)}, {prop: "GetByFrameId", name: "GetByFrameId", pkg: "", typ: $funcType([$Int32], [$emptyInterface], false)}, {prop: "SetByFrameId", name: "SetByFrameId", pkg: "", typ: $funcType([$emptyInterface, $Int32], [$Int32, $Int32, $Int32], false)}, {prop: "Clear", name: "Clear", pkg: "", typ: $funcType([], [], false)}, {prop: "GetStFrameId", name: "GetStFrameId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetEdFrameId", name: "GetEdFrameId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetCnt", name: "GetCnt", pkg: "", typ: $funcType([], [$Int32], false)}];
	ptrType$2.methods = [{prop: "GetData", name: "GetData", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "GetShape", name: "GetShape", pkg: "", typ: $funcType([], [ptrType$8], false)}, {prop: "Position", name: "Position", pkg: "", typ: $funcType([], [$Float64, $Float64], false)}, {prop: "Clone", name: "Clone", pkg: "", typ: $funcType([], [ptrType$2], false)}, {prop: "Update", name: "Update", pkg: "", typ: $funcType([], [], false)}, {prop: "AddTags", name: "AddTags", pkg: "", typ: $funcType([sliceType$7], [], true)}, {prop: "RemoveTags", name: "RemoveTags", pkg: "", typ: $funcType([sliceType$7], [], true)}, {prop: "HasTags", name: "HasTags", pkg: "", typ: $funcType([sliceType$7], [$Bool], true)}, {prop: "Tags", name: "Tags", pkg: "", typ: $funcType([], [sliceType$7], false)}, {prop: "SetShape", name: "SetShape", pkg: "", typ: $funcType([Shape], [], false)}, {prop: "BoundsToSpace", name: "BoundsToSpace", pkg: "", typ: $funcType([$Float64, $Float64], [$Int, $Int, $Int, $Int], false)}, {prop: "SharesCells", name: "SharesCells", pkg: "", typ: $funcType([ptrType$2], [$Bool], false)}, {prop: "SharesCellsTags", name: "SharesCellsTags", pkg: "", typ: $funcType([sliceType$7], [$Bool], true)}, {prop: "Center", name: "Center", pkg: "", typ: $funcType([], [$Float64, $Float64], false)}, {prop: "SetCenter", name: "SetCenter", pkg: "", typ: $funcType([$Float64, $Float64], [], false)}, {prop: "CellPosition", name: "CellPosition", pkg: "", typ: $funcType([], [$Int, $Int], false)}, {prop: "SetRight", name: "SetRight", pkg: "", typ: $funcType([$Float64], [], false)}, {prop: "SetBottom", name: "SetBottom", pkg: "", typ: $funcType([$Float64], [], false)}, {prop: "Bottom", name: "Bottom", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Right", name: "Right", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "SetBounds", name: "SetBounds", pkg: "", typ: $funcType([Vector, Vector], [], false)}, {prop: "CheckAllWithHolder", name: "CheckAllWithHolder", pkg: "", typ: $funcType([$Float64, $Float64, ptrType$9], [$Bool], false)}, {prop: "Overlaps", name: "Overlaps", pkg: "", typ: $funcType([ptrType$2], [$Bool], false)}, {prop: "AddToIgnoreList", name: "AddToIgnoreList", pkg: "", typ: $funcType([ptrType$2], [], false)}, {prop: "RemoveFromIgnoreList", name: "RemoveFromIgnoreList", pkg: "", typ: $funcType([ptrType$2], [], false)}];
	ptrType$9.methods = [{prop: "Clear", name: "Clear", pkg: "", typ: $funcType([], [], false)}, {prop: "PopFirstCollidedObject", name: "PopFirstCollidedObject", pkg: "", typ: $funcType([], [ptrType$2], false)}, {prop: "HasTags", name: "HasTags", pkg: "", typ: $funcType([sliceType$7], [$Bool], true)}, {prop: "ObjectsByTags", name: "ObjectsByTags", pkg: "", typ: $funcType([sliceType$7], [sliceType$3], true)}, {prop: "ContactWithObject", name: "ContactWithObject", pkg: "", typ: $funcType([ptrType$2], [Vector], false)}, {prop: "ContactWithCell", name: "ContactWithCell", pkg: "", typ: $funcType([ptrType], [Vector], false)}, {prop: "SlideAgainstCell", name: "SlideAgainstCell", pkg: "", typ: $funcType([ptrType, sliceType$7], [Vector], true)}];
	ptrType.methods = [{prop: "register", name: "register", pkg: "resolv", typ: $funcType([ptrType$2], [], false)}, {prop: "unregister", name: "unregister", pkg: "resolv", typ: $funcType([ptrType$2], [], false)}, {prop: "Contains", name: "Contains", pkg: "", typ: $funcType([ptrType$2], [$Bool], false)}, {prop: "ContainsTags", name: "ContainsTags", pkg: "", typ: $funcType([sliceType$7], [$Bool], true)}, {prop: "Occupied", name: "Occupied", pkg: "", typ: $funcType([], [$Bool], false)}];
	Vector.init($Float64);
	Space.init("", [{prop: "Cells", name: "Cells", embedded: false, exported: true, typ: sliceType$2, tag: ""}, {prop: "CellWidth", name: "CellWidth", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "CellHeight", name: "CellHeight", embedded: false, exported: true, typ: $Int, tag: ""}]);
	Shape.init([{prop: "Bounds", name: "Bounds", pkg: "", typ: $funcType([], [Vector, Vector], false)}, {prop: "Clone", name: "Clone", pkg: "", typ: $funcType([], [Shape], false)}, {prop: "Intersection", name: "Intersection", pkg: "", typ: $funcType([$Float64, $Float64, Shape], [ptrType$7], false)}, {prop: "Position", name: "Position", pkg: "", typ: $funcType([], [$Float64, $Float64], false)}, {prop: "SetPosition", name: "SetPosition", pkg: "", typ: $funcType([$Float64, $Float64], [], false)}]);
	Line.init("", [{prop: "Start", name: "Start", embedded: false, exported: true, typ: Vector, tag: ""}, {prop: "End", name: "End", embedded: false, exported: true, typ: Vector, tag: ""}]);
	ConvexPolygon.init("", [{prop: "Points", name: "Points", embedded: false, exported: true, typ: ptrType$3, tag: ""}, {prop: "X", name: "X", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Y", name: "Y", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Closed", name: "Closed", embedded: false, exported: true, typ: $Bool, tag: ""}]);
	ContactSet.init("", [{prop: "Points", name: "Points", embedded: false, exported: true, typ: sliceType$4, tag: ""}, {prop: "MTV", name: "MTV", embedded: false, exported: true, typ: Vector, tag: ""}, {prop: "Center", name: "Center", embedded: false, exported: true, typ: Vector, tag: ""}]);
	Circle.init("", [{prop: "X", name: "X", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Y", name: "Y", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Radius", name: "Radius", embedded: false, exported: true, typ: $Float64, tag: ""}]);
	Projection.init("", [{prop: "Min", name: "Min", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Max", name: "Max", embedded: false, exported: true, typ: $Float64, tag: ""}]);
	RingBuffer.init("", [{prop: "Ed", name: "Ed", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "St", name: "St", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "EdFrameId", name: "EdFrameId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "StFrameId", name: "StFrameId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "N", name: "N", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Cnt", name: "Cnt", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Eles", name: "Eles", embedded: false, exported: true, typ: sliceType$6, tag: ""}]);
	Object.init("resolv", [{prop: "Shape", name: "Shape", embedded: false, exported: true, typ: Shape, tag: ""}, {prop: "Space", name: "Space", embedded: false, exported: true, typ: ptrType$1, tag: ""}, {prop: "X", name: "X", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Y", name: "Y", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "W", name: "W", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "H", name: "H", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "TouchingCells", name: "TouchingCells", embedded: false, exported: true, typ: ptrType$3, tag: ""}, {prop: "Data", name: "Data", embedded: false, exported: true, typ: $emptyInterface, tag: ""}, {prop: "ignoreList", name: "ignoreList", embedded: false, exported: false, typ: mapType, tag: ""}, {prop: "tags", name: "tags", embedded: false, exported: false, typ: sliceType$7, tag: ""}]);
	Collision.init("resolv", [{prop: "checkingObject", name: "checkingObject", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "dx", name: "dx", embedded: false, exported: false, typ: $Float64, tag: ""}, {prop: "dy", name: "dy", embedded: false, exported: false, typ: $Float64, tag: ""}, {prop: "Objects", name: "Objects", embedded: false, exported: true, typ: ptrType$3, tag: ""}, {prop: "Cells", name: "Cells", embedded: false, exported: true, typ: ptrType$3, tag: ""}]);
	Cell.init("", [{prop: "X", name: "X", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "Y", name: "Y", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "Objects", name: "Objects", embedded: false, exported: true, typ: ptrType$3, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = math.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["jsexport/battle"] = (function() {
	var $pkg = {}, $init, math, resolv, Vec2D, Polygon2D, PlayerDownsync, InputFrameDecoded, Barrier, BulletConfig, BulletBattleAttr, MeleeBullet, FireballBullet, Skill, RoomDownsyncFrame, InputFrameDownsync, NpcPatrolCue, SkillMapperType, CharacterConfig, SatResult, sliceType, sliceType$1, sliceType$2, ptrType, ptrType$1, ptrType$2, ptrType$3, ptrType$4, ptrType$5, ptrType$6, ptrType$7, ptrType$8, ptrType$9, sliceType$3, ptrType$10, sliceType$4, sliceType$5, ptrType$11, sliceType$6, sliceType$7, sliceType$8, sliceType$9, ptrType$12, mapType, ptrType$13, skills, inAirSet, noOpSet, invinsibleSet, nonAttackingSet, intAbs, ShouldGenerateInputFrameUpsync, ConvertToDelayedInputFrameId, ConvertToNoDelayInputFrameId, ConvertToFirstUsedRenderFrameId, ConvertToLastUsedRenderFrameId, decodeInput, calcPushbacks, isPolygonPairOverlapped, IsGeneralBulletActive, IsMeleeBulletActive, IsMeleeBulletAlive, IsFireballBulletActive, IsFireballBulletAlive, isPolygonPairSeparatedByDir, WorldToVirtualGridPos, VirtualGridToWorldPos, WorldToPolygonColliderBLPos, PolygonColliderBLToWorldPos, PolygonColliderBLToVirtualGridPos, calcHardPushbacksNorms, deriveOpPattern, ApplyInputFrameDownsyncDynamicsOnSingleRenderFrame, GenerateRectCollider, generateRectColliderInCollisionSpace, UpdateRectCollider, GenerateConvexPolygonCollider, AlignPolygon2DToBoundingBox, NewMeleeBullet, NewFireballBullet, NewPlayerDownsync, CloneMeleeBullet, CloneFireballBullet, ClonePlayerDownsync, CloneRoomDownsyncFrame, NewPreallocatedRoomDownsyncFrame;
	math = $packages["math"];
	resolv = $packages["resolv"];
	Vec2D = $pkg.Vec2D = $newType(0, $kindStruct, "battle.Vec2D", true, "jsexport/battle", true, function(X_, Y_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.X = 0;
			this.Y = 0;
			return;
		}
		this.X = X_;
		this.Y = Y_;
	});
	Polygon2D = $pkg.Polygon2D = $newType(0, $kindStruct, "battle.Polygon2D", true, "jsexport/battle", true, function(Anchor_, Points_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Anchor = ptrType$11.nil;
			this.Points = sliceType$6.nil;
			return;
		}
		this.Anchor = Anchor_;
		this.Points = Points_;
	});
	PlayerDownsync = $pkg.PlayerDownsync = $newType(0, $kindStruct, "battle.PlayerDownsync", true, "jsexport/battle", true, function(Id_, VirtualGridX_, VirtualGridY_, DirX_, DirY_, VelX_, VelY_, Speed_, BattleState_, JoinIndex_, ColliderRadius_, Removed_, Score_, LastMoveGmtMillis_, FramesToRecover_, FramesInChState_, Hp_, MaxHp_, CharacterState_, InAir_, OnWall_, OnWallNormX_, OnWallNormY_, CapturedByInertia_, ActiveSkillId_, ActiveSkillHit_, FramesInvinsible_, BulletTeamId_, ChCollisionTeamId_, RevivalVirtualGridX_, RevivalVirtualGridY_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Id = 0;
			this.VirtualGridX = 0;
			this.VirtualGridY = 0;
			this.DirX = 0;
			this.DirY = 0;
			this.VelX = 0;
			this.VelY = 0;
			this.Speed = 0;
			this.BattleState = 0;
			this.JoinIndex = 0;
			this.ColliderRadius = 0;
			this.Removed = false;
			this.Score = 0;
			this.LastMoveGmtMillis = 0;
			this.FramesToRecover = 0;
			this.FramesInChState = 0;
			this.Hp = 0;
			this.MaxHp = 0;
			this.CharacterState = 0;
			this.InAir = false;
			this.OnWall = false;
			this.OnWallNormX = 0;
			this.OnWallNormY = 0;
			this.CapturedByInertia = false;
			this.ActiveSkillId = 0;
			this.ActiveSkillHit = 0;
			this.FramesInvinsible = 0;
			this.BulletTeamId = 0;
			this.ChCollisionTeamId = 0;
			this.RevivalVirtualGridX = 0;
			this.RevivalVirtualGridY = 0;
			return;
		}
		this.Id = Id_;
		this.VirtualGridX = VirtualGridX_;
		this.VirtualGridY = VirtualGridY_;
		this.DirX = DirX_;
		this.DirY = DirY_;
		this.VelX = VelX_;
		this.VelY = VelY_;
		this.Speed = Speed_;
		this.BattleState = BattleState_;
		this.JoinIndex = JoinIndex_;
		this.ColliderRadius = ColliderRadius_;
		this.Removed = Removed_;
		this.Score = Score_;
		this.LastMoveGmtMillis = LastMoveGmtMillis_;
		this.FramesToRecover = FramesToRecover_;
		this.FramesInChState = FramesInChState_;
		this.Hp = Hp_;
		this.MaxHp = MaxHp_;
		this.CharacterState = CharacterState_;
		this.InAir = InAir_;
		this.OnWall = OnWall_;
		this.OnWallNormX = OnWallNormX_;
		this.OnWallNormY = OnWallNormY_;
		this.CapturedByInertia = CapturedByInertia_;
		this.ActiveSkillId = ActiveSkillId_;
		this.ActiveSkillHit = ActiveSkillHit_;
		this.FramesInvinsible = FramesInvinsible_;
		this.BulletTeamId = BulletTeamId_;
		this.ChCollisionTeamId = ChCollisionTeamId_;
		this.RevivalVirtualGridX = RevivalVirtualGridX_;
		this.RevivalVirtualGridY = RevivalVirtualGridY_;
	});
	InputFrameDecoded = $pkg.InputFrameDecoded = $newType(0, $kindStruct, "battle.InputFrameDecoded", true, "jsexport/battle", true, function(Dx_, Dy_, BtnALevel_, BtnBLevel_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Dx = 0;
			this.Dy = 0;
			this.BtnALevel = 0;
			this.BtnBLevel = 0;
			return;
		}
		this.Dx = Dx_;
		this.Dy = Dy_;
		this.BtnALevel = BtnALevel_;
		this.BtnBLevel = BtnBLevel_;
	});
	Barrier = $pkg.Barrier = $newType(0, $kindStruct, "battle.Barrier", true, "jsexport/battle", true, function(Boundary_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Boundary = ptrType$12.nil;
			return;
		}
		this.Boundary = Boundary_;
	});
	BulletConfig = $pkg.BulletConfig = $newType(0, $kindStruct, "battle.BulletConfig", true, "jsexport/battle", true, function(StartupFrames_, CancellableStFrame_, CancellableEdFrame_, ActiveFrames_, HitStunFrames_, BlockStunFrames_, PushbackVelX_, PushbackVelY_, Damage_, SelfLockVelX_, SelfLockVelY_, HitboxOffsetX_, HitboxOffsetY_, HitboxSizeX_, HitboxSizeY_, BlowUp_, ExplosionFrames_, SpeciesId_, CancelTransit_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.StartupFrames = 0;
			this.CancellableStFrame = 0;
			this.CancellableEdFrame = 0;
			this.ActiveFrames = 0;
			this.HitStunFrames = 0;
			this.BlockStunFrames = 0;
			this.PushbackVelX = 0;
			this.PushbackVelY = 0;
			this.Damage = 0;
			this.SelfLockVelX = 0;
			this.SelfLockVelY = 0;
			this.HitboxOffsetX = 0;
			this.HitboxOffsetY = 0;
			this.HitboxSizeX = 0;
			this.HitboxSizeY = 0;
			this.BlowUp = false;
			this.ExplosionFrames = 0;
			this.SpeciesId = 0;
			this.CancelTransit = false;
			return;
		}
		this.StartupFrames = StartupFrames_;
		this.CancellableStFrame = CancellableStFrame_;
		this.CancellableEdFrame = CancellableEdFrame_;
		this.ActiveFrames = ActiveFrames_;
		this.HitStunFrames = HitStunFrames_;
		this.BlockStunFrames = BlockStunFrames_;
		this.PushbackVelX = PushbackVelX_;
		this.PushbackVelY = PushbackVelY_;
		this.Damage = Damage_;
		this.SelfLockVelX = SelfLockVelX_;
		this.SelfLockVelY = SelfLockVelY_;
		this.HitboxOffsetX = HitboxOffsetX_;
		this.HitboxOffsetY = HitboxOffsetY_;
		this.HitboxSizeX = HitboxSizeX_;
		this.HitboxSizeY = HitboxSizeY_;
		this.BlowUp = BlowUp_;
		this.ExplosionFrames = ExplosionFrames_;
		this.SpeciesId = SpeciesId_;
		this.CancelTransit = CancelTransit_;
	});
	BulletBattleAttr = $pkg.BulletBattleAttr = $newType(0, $kindStruct, "battle.BulletBattleAttr", true, "jsexport/battle", true, function(BulletLocalId_, OriginatedRenderFrameId_, OffenderJoinIndex_, TeamId_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.BulletLocalId = 0;
			this.OriginatedRenderFrameId = 0;
			this.OffenderJoinIndex = 0;
			this.TeamId = 0;
			return;
		}
		this.BulletLocalId = BulletLocalId_;
		this.OriginatedRenderFrameId = OriginatedRenderFrameId_;
		this.OffenderJoinIndex = OffenderJoinIndex_;
		this.TeamId = TeamId_;
	});
	MeleeBullet = $pkg.MeleeBullet = $newType(0, $kindStruct, "battle.MeleeBullet", true, "jsexport/battle", true, function(BlState_, FramesInBlState_, BattleAttr_, Bullet_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.BlState = 0;
			this.FramesInBlState = 0;
			this.BattleAttr = ptrType.nil;
			this.Bullet = ptrType$1.nil;
			return;
		}
		this.BlState = BlState_;
		this.FramesInBlState = FramesInBlState_;
		this.BattleAttr = BattleAttr_;
		this.Bullet = Bullet_;
	});
	FireballBullet = $pkg.FireballBullet = $newType(0, $kindStruct, "battle.FireballBullet", true, "jsexport/battle", true, function(VirtualGridX_, VirtualGridY_, DirX_, DirY_, VelX_, VelY_, Speed_, BlState_, FramesInBlState_, BattleAttr_, Bullet_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.VirtualGridX = 0;
			this.VirtualGridY = 0;
			this.DirX = 0;
			this.DirY = 0;
			this.VelX = 0;
			this.VelY = 0;
			this.Speed = 0;
			this.BlState = 0;
			this.FramesInBlState = 0;
			this.BattleAttr = ptrType.nil;
			this.Bullet = ptrType$1.nil;
			return;
		}
		this.VirtualGridX = VirtualGridX_;
		this.VirtualGridY = VirtualGridY_;
		this.DirX = DirX_;
		this.DirY = DirY_;
		this.VelX = VelX_;
		this.VelY = VelY_;
		this.Speed = Speed_;
		this.BlState = BlState_;
		this.FramesInBlState = FramesInBlState_;
		this.BattleAttr = BattleAttr_;
		this.Bullet = Bullet_;
	});
	Skill = $pkg.Skill = $newType(0, $kindStruct, "battle.Skill", true, "jsexport/battle", true, function(BattleLocalId_, RecoveryFrames_, RecoveryFramesOnBlock_, RecoveryFramesOnHit_, ReleaseTriggerType_, BoundChState_, Hits_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.BattleLocalId = 0;
			this.RecoveryFrames = 0;
			this.RecoveryFramesOnBlock = 0;
			this.RecoveryFramesOnHit = 0;
			this.ReleaseTriggerType = 0;
			this.BoundChState = 0;
			this.Hits = sliceType$2.nil;
			return;
		}
		this.BattleLocalId = BattleLocalId_;
		this.RecoveryFrames = RecoveryFrames_;
		this.RecoveryFramesOnBlock = RecoveryFramesOnBlock_;
		this.RecoveryFramesOnHit = RecoveryFramesOnHit_;
		this.ReleaseTriggerType = ReleaseTriggerType_;
		this.BoundChState = BoundChState_;
		this.Hits = Hits_;
	});
	RoomDownsyncFrame = $pkg.RoomDownsyncFrame = $newType(0, $kindStruct, "battle.RoomDownsyncFrame", true, "jsexport/battle", true, function(Id_, PlayersArr_, CountdownNanos_, MeleeBullets_, FireballBullets_, BackendUnconfirmedMask_, ShouldForceResync_, BulletLocalIdCounter_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Id = 0;
			this.PlayersArr = sliceType$7.nil;
			this.CountdownNanos = new $Int64(0, 0);
			this.MeleeBullets = sliceType$8.nil;
			this.FireballBullets = sliceType$9.nil;
			this.BackendUnconfirmedMask = new $Uint64(0, 0);
			this.ShouldForceResync = false;
			this.BulletLocalIdCounter = 0;
			return;
		}
		this.Id = Id_;
		this.PlayersArr = PlayersArr_;
		this.CountdownNanos = CountdownNanos_;
		this.MeleeBullets = MeleeBullets_;
		this.FireballBullets = FireballBullets_;
		this.BackendUnconfirmedMask = BackendUnconfirmedMask_;
		this.ShouldForceResync = ShouldForceResync_;
		this.BulletLocalIdCounter = BulletLocalIdCounter_;
	});
	InputFrameDownsync = $pkg.InputFrameDownsync = $newType(0, $kindStruct, "battle.InputFrameDownsync", true, "jsexport/battle", true, function(InputFrameId_, InputList_, ConfirmedList_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.InputFrameId = 0;
			this.InputList = sliceType$3.nil;
			this.ConfirmedList = new $Uint64(0, 0);
			return;
		}
		this.InputFrameId = InputFrameId_;
		this.InputList = InputList_;
		this.ConfirmedList = ConfirmedList_;
	});
	NpcPatrolCue = $pkg.NpcPatrolCue = $newType(0, $kindStruct, "battle.NpcPatrolCue", true, "jsexport/battle", true, function(FlAct_, FrAct_, X_, Y_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.FlAct = new $Uint64(0, 0);
			this.FrAct = new $Uint64(0, 0);
			this.X = 0;
			this.Y = 0;
			return;
		}
		this.FlAct = FlAct_;
		this.FrAct = FrAct_;
		this.X = X_;
		this.Y = Y_;
	});
	SkillMapperType = $pkg.SkillMapperType = $newType(4, $kindFunc, "battle.SkillMapperType", true, "jsexport/battle", true, null);
	CharacterConfig = $pkg.CharacterConfig = $newType(0, $kindStruct, "battle.CharacterConfig", true, "jsexport/battle", true, function(SpeciesId_, SpeciesName_, InAirIdleFrameIdxTurningPoint_, InAirIdleFrameIdxTurnedCycle_, LayDownFrames_, LayDownFramesToRecover_, GetUpInvinsibleFrames_, GetUpFramesToRecover_, Speed_, JumpingInitVelY_, JumpingFramesToRecover_, DashingEnabled_, OnWallEnabled_, WallJumpingFramesToRecover_, WallJumpingInitVelX_, WallJumpingInitVelY_, WallSlidingVelY_, InertiaFramesToRecover_, SkillMapper_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.SpeciesId = 0;
			this.SpeciesName = "";
			this.InAirIdleFrameIdxTurningPoint = 0;
			this.InAirIdleFrameIdxTurnedCycle = 0;
			this.LayDownFrames = 0;
			this.LayDownFramesToRecover = 0;
			this.GetUpInvinsibleFrames = 0;
			this.GetUpFramesToRecover = 0;
			this.Speed = 0;
			this.JumpingInitVelY = 0;
			this.JumpingFramesToRecover = 0;
			this.DashingEnabled = false;
			this.OnWallEnabled = false;
			this.WallJumpingFramesToRecover = 0;
			this.WallJumpingInitVelX = 0;
			this.WallJumpingInitVelY = 0;
			this.WallSlidingVelY = 0;
			this.InertiaFramesToRecover = 0;
			this.SkillMapper = $throwNilPointerError;
			return;
		}
		this.SpeciesId = SpeciesId_;
		this.SpeciesName = SpeciesName_;
		this.InAirIdleFrameIdxTurningPoint = InAirIdleFrameIdxTurningPoint_;
		this.InAirIdleFrameIdxTurnedCycle = InAirIdleFrameIdxTurnedCycle_;
		this.LayDownFrames = LayDownFrames_;
		this.LayDownFramesToRecover = LayDownFramesToRecover_;
		this.GetUpInvinsibleFrames = GetUpInvinsibleFrames_;
		this.GetUpFramesToRecover = GetUpFramesToRecover_;
		this.Speed = Speed_;
		this.JumpingInitVelY = JumpingInitVelY_;
		this.JumpingFramesToRecover = JumpingFramesToRecover_;
		this.DashingEnabled = DashingEnabled_;
		this.OnWallEnabled = OnWallEnabled_;
		this.WallJumpingFramesToRecover = WallJumpingFramesToRecover_;
		this.WallJumpingInitVelX = WallJumpingInitVelX_;
		this.WallJumpingInitVelY = WallJumpingInitVelY_;
		this.WallSlidingVelY = WallSlidingVelY_;
		this.InertiaFramesToRecover = InertiaFramesToRecover_;
		this.SkillMapper = SkillMapper_;
	});
	SatResult = $pkg.SatResult = $newType(0, $kindStruct, "battle.SatResult", true, "jsexport/battle", true, function(Overlap_, OverlapX_, OverlapY_, AContainedInB_, BContainedInA_, Axis_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Overlap = 0;
			this.OverlapX = 0;
			this.OverlapY = 0;
			this.AContainedInB = false;
			this.BContainedInA = false;
			this.Axis = resolv.Vector.nil;
			return;
		}
		this.Overlap = Overlap_;
		this.OverlapX = OverlapX_;
		this.OverlapY = OverlapY_;
		this.AContainedInB = AContainedInB_;
		this.BContainedInA = BContainedInA_;
		this.Axis = Axis_;
	});
	sliceType = $sliceType($Int32);
	sliceType$1 = $sliceType(sliceType);
	sliceType$2 = $sliceType($emptyInterface);
	ptrType = $ptrType(BulletBattleAttr);
	ptrType$1 = $ptrType(BulletConfig);
	ptrType$2 = $ptrType(Skill);
	ptrType$3 = $ptrType(MeleeBullet);
	ptrType$4 = $ptrType(SatResult);
	ptrType$5 = $ptrType(resolv.Object);
	ptrType$6 = $ptrType(PlayerDownsync);
	ptrType$7 = $ptrType(FireballBullet);
	ptrType$8 = $ptrType(resolv.ConvexPolygon);
	ptrType$9 = $ptrType(InputFrameDownsync);
	sliceType$3 = $sliceType($Uint64);
	ptrType$10 = $ptrType(RoomDownsyncFrame);
	sliceType$4 = $sliceType($Float64);
	sliceType$5 = $sliceType($String);
	ptrType$11 = $ptrType(Vec2D);
	sliceType$6 = $sliceType(ptrType$11);
	sliceType$7 = $sliceType(ptrType$6);
	sliceType$8 = $sliceType(ptrType$3);
	sliceType$9 = $sliceType(ptrType$7);
	ptrType$12 = $ptrType(Polygon2D);
	mapType = $mapType($Int, $Int);
	ptrType$13 = $ptrType(CharacterConfig);
	CharacterConfig.ptr.prototype.GetSpeed = function() {
		var c;
		c = this;
		return c.Speed;
	};
	CharacterConfig.prototype.GetSpeed = function() { return this.$val.GetSpeed(); };
	CharacterConfig.ptr.prototype.GetSpeciesId = function() {
		var c;
		c = this;
		return c.SpeciesId;
	};
	CharacterConfig.prototype.GetSpeciesId = function() { return this.$val.GetSpeciesId(); };
	CharacterConfig.ptr.prototype.GetSpeciesName = function() {
		var c;
		c = this;
		return c.SpeciesName;
	};
	CharacterConfig.prototype.GetSpeciesName = function() { return this.$val.GetSpeciesName(); };
	InputFrameDownsync.ptr.prototype.GetInputFrameId = function() {
		var ifd;
		ifd = this;
		return ifd.InputFrameId;
	};
	InputFrameDownsync.prototype.GetInputFrameId = function() { return this.$val.GetInputFrameId(); };
	InputFrameDownsync.ptr.prototype.GetInputList = function() {
		var ifd;
		ifd = this;
		return ifd.InputList;
	};
	InputFrameDownsync.prototype.GetInputList = function() { return this.$val.GetInputList(); };
	InputFrameDownsync.ptr.prototype.GetConfirmedList = function() {
		var ifd;
		ifd = this;
		return ifd.ConfirmedList;
	};
	InputFrameDownsync.prototype.GetConfirmedList = function() { return this.$val.GetConfirmedList(); };
	PlayerDownsync.ptr.prototype.GetId = function() {
		var p;
		p = this;
		return p.Id;
	};
	PlayerDownsync.prototype.GetId = function() { return this.$val.GetId(); };
	PlayerDownsync.ptr.prototype.GetJoinIndex = function() {
		var p;
		p = this;
		return p.JoinIndex;
	};
	PlayerDownsync.prototype.GetJoinIndex = function() { return this.$val.GetJoinIndex(); };
	PlayerDownsync.ptr.prototype.GetVirtualGridX = function() {
		var p;
		p = this;
		return p.VirtualGridX;
	};
	PlayerDownsync.prototype.GetVirtualGridX = function() { return this.$val.GetVirtualGridX(); };
	PlayerDownsync.ptr.prototype.GetVirtualGridY = function() {
		var p;
		p = this;
		return p.VirtualGridY;
	};
	PlayerDownsync.prototype.GetVirtualGridY = function() { return this.$val.GetVirtualGridY(); };
	PlayerDownsync.ptr.prototype.GetDirX = function() {
		var p;
		p = this;
		return p.DirX;
	};
	PlayerDownsync.prototype.GetDirX = function() { return this.$val.GetDirX(); };
	PlayerDownsync.ptr.prototype.GetDirY = function() {
		var p;
		p = this;
		return p.DirY;
	};
	PlayerDownsync.prototype.GetDirY = function() { return this.$val.GetDirY(); };
	PlayerDownsync.ptr.prototype.GetVelX = function() {
		var p;
		p = this;
		return p.VelX;
	};
	PlayerDownsync.prototype.GetVelX = function() { return this.$val.GetVelX(); };
	PlayerDownsync.ptr.prototype.GetVelY = function() {
		var p;
		p = this;
		return p.VelY;
	};
	PlayerDownsync.prototype.GetVelY = function() { return this.$val.GetVelY(); };
	PlayerDownsync.ptr.prototype.GetSpeed = function() {
		var p;
		p = this;
		return p.Speed;
	};
	PlayerDownsync.prototype.GetSpeed = function() { return this.$val.GetSpeed(); };
	PlayerDownsync.ptr.prototype.GetHp = function() {
		var p;
		p = this;
		return p.Hp;
	};
	PlayerDownsync.prototype.GetHp = function() { return this.$val.GetHp(); };
	PlayerDownsync.ptr.prototype.GetMaxHp = function() {
		var p;
		p = this;
		return p.MaxHp;
	};
	PlayerDownsync.prototype.GetMaxHp = function() { return this.$val.GetMaxHp(); };
	PlayerDownsync.ptr.prototype.GetCharacterState = function() {
		var p;
		p = this;
		return p.CharacterState;
	};
	PlayerDownsync.prototype.GetCharacterState = function() { return this.$val.GetCharacterState(); };
	PlayerDownsync.ptr.prototype.GetFramesToRecover = function() {
		var p;
		p = this;
		return p.FramesToRecover;
	};
	PlayerDownsync.prototype.GetFramesToRecover = function() { return this.$val.GetFramesToRecover(); };
	PlayerDownsync.ptr.prototype.GetFramesInChState = function() {
		var p;
		p = this;
		return p.FramesInChState;
	};
	PlayerDownsync.prototype.GetFramesInChState = function() { return this.$val.GetFramesInChState(); };
	PlayerDownsync.ptr.prototype.GetInAir = function() {
		var p;
		p = this;
		return p.InAir;
	};
	PlayerDownsync.prototype.GetInAir = function() { return this.$val.GetInAir(); };
	PlayerDownsync.ptr.prototype.GetOnWall = function() {
		var p;
		p = this;
		return p.OnWall;
	};
	PlayerDownsync.prototype.GetOnWall = function() { return this.$val.GetOnWall(); };
	PlayerDownsync.ptr.prototype.GetOnWallNormX = function() {
		var p;
		p = this;
		return p.OnWallNormX;
	};
	PlayerDownsync.prototype.GetOnWallNormX = function() { return this.$val.GetOnWallNormX(); };
	PlayerDownsync.ptr.prototype.GetColliderRadius = function() {
		var p;
		p = this;
		return p.ColliderRadius;
	};
	PlayerDownsync.prototype.GetColliderRadius = function() { return this.$val.GetColliderRadius(); };
	MeleeBullet.ptr.prototype.GetBlState = function() {
		var b;
		b = this;
		return b.BlState;
	};
	MeleeBullet.prototype.GetBlState = function() { return this.$val.GetBlState(); };
	MeleeBullet.ptr.prototype.GetFramesInBlState = function() {
		var b;
		b = this;
		return b.FramesInBlState;
	};
	MeleeBullet.prototype.GetFramesInBlState = function() { return this.$val.GetFramesInBlState(); };
	MeleeBullet.ptr.prototype.GetBulletLocalId = function() {
		var b;
		b = this;
		return b.BattleAttr.BulletLocalId;
	};
	MeleeBullet.prototype.GetBulletLocalId = function() { return this.$val.GetBulletLocalId(); };
	MeleeBullet.ptr.prototype.GetOffenderJoinIndex = function() {
		var b;
		b = this;
		return b.BattleAttr.OffenderJoinIndex;
	};
	MeleeBullet.prototype.GetOffenderJoinIndex = function() { return this.$val.GetOffenderJoinIndex(); };
	MeleeBullet.ptr.prototype.GetOriginatedRenderFrameId = function() {
		var b;
		b = this;
		return b.BattleAttr.OriginatedRenderFrameId;
	};
	MeleeBullet.prototype.GetOriginatedRenderFrameId = function() { return this.$val.GetOriginatedRenderFrameId(); };
	MeleeBullet.ptr.prototype.GetStartupFrames = function() {
		var b;
		b = this;
		return b.Bullet.StartupFrames;
	};
	MeleeBullet.prototype.GetStartupFrames = function() { return this.$val.GetStartupFrames(); };
	MeleeBullet.ptr.prototype.GetActiveFrames = function() {
		var b;
		b = this;
		return b.Bullet.ActiveFrames;
	};
	MeleeBullet.prototype.GetActiveFrames = function() { return this.$val.GetActiveFrames(); };
	MeleeBullet.ptr.prototype.GetHitboxSizeX = function() {
		var b;
		b = this;
		return b.Bullet.HitboxSizeX;
	};
	MeleeBullet.prototype.GetHitboxSizeX = function() { return this.$val.GetHitboxSizeX(); };
	MeleeBullet.ptr.prototype.GetHitboxSizeY = function() {
		var b;
		b = this;
		return b.Bullet.HitboxSizeY;
	};
	MeleeBullet.prototype.GetHitboxSizeY = function() { return this.$val.GetHitboxSizeY(); };
	MeleeBullet.ptr.prototype.GetHitboxOffsetX = function() {
		var b;
		b = this;
		return b.Bullet.HitboxOffsetX;
	};
	MeleeBullet.prototype.GetHitboxOffsetX = function() { return this.$val.GetHitboxOffsetX(); };
	MeleeBullet.ptr.prototype.GetHitboxOffsetY = function() {
		var b;
		b = this;
		return b.Bullet.HitboxOffsetY;
	};
	MeleeBullet.prototype.GetHitboxOffsetY = function() { return this.$val.GetHitboxOffsetY(); };
	MeleeBullet.ptr.prototype.GetExplosionFrames = function() {
		var b;
		b = this;
		return b.Bullet.ExplosionFrames;
	};
	MeleeBullet.prototype.GetExplosionFrames = function() { return this.$val.GetExplosionFrames(); };
	MeleeBullet.ptr.prototype.GetSpeciesId = function() {
		var b;
		b = this;
		return b.Bullet.SpeciesId;
	};
	MeleeBullet.prototype.GetSpeciesId = function() { return this.$val.GetSpeciesId(); };
	FireballBullet.ptr.prototype.GetVirtualGridX = function() {
		var p;
		p = this;
		return p.VirtualGridX;
	};
	FireballBullet.prototype.GetVirtualGridX = function() { return this.$val.GetVirtualGridX(); };
	FireballBullet.ptr.prototype.GetVirtualGridY = function() {
		var p;
		p = this;
		return p.VirtualGridY;
	};
	FireballBullet.prototype.GetVirtualGridY = function() { return this.$val.GetVirtualGridY(); };
	FireballBullet.ptr.prototype.GetDirX = function() {
		var p;
		p = this;
		return p.DirX;
	};
	FireballBullet.prototype.GetDirX = function() { return this.$val.GetDirX(); };
	FireballBullet.ptr.prototype.GetDirY = function() {
		var p;
		p = this;
		return p.DirY;
	};
	FireballBullet.prototype.GetDirY = function() { return this.$val.GetDirY(); };
	FireballBullet.ptr.prototype.GetVelX = function() {
		var p;
		p = this;
		return p.VelX;
	};
	FireballBullet.prototype.GetVelX = function() { return this.$val.GetVelX(); };
	FireballBullet.ptr.prototype.GetVelY = function() {
		var p;
		p = this;
		return p.VelY;
	};
	FireballBullet.prototype.GetVelY = function() { return this.$val.GetVelY(); };
	FireballBullet.ptr.prototype.GetSpeed = function() {
		var p;
		p = this;
		return p.Speed;
	};
	FireballBullet.prototype.GetSpeed = function() { return this.$val.GetSpeed(); };
	FireballBullet.ptr.prototype.GetBlState = function() {
		var b;
		b = this;
		return b.BlState;
	};
	FireballBullet.prototype.GetBlState = function() { return this.$val.GetBlState(); };
	FireballBullet.ptr.prototype.GetFramesInBlState = function() {
		var b;
		b = this;
		return b.FramesInBlState;
	};
	FireballBullet.prototype.GetFramesInBlState = function() { return this.$val.GetFramesInBlState(); };
	FireballBullet.ptr.prototype.GetBulletLocalId = function() {
		var b;
		b = this;
		return b.BattleAttr.BulletLocalId;
	};
	FireballBullet.prototype.GetBulletLocalId = function() { return this.$val.GetBulletLocalId(); };
	FireballBullet.ptr.prototype.GetOffenderJoinIndex = function() {
		var b;
		b = this;
		return b.BattleAttr.OffenderJoinIndex;
	};
	FireballBullet.prototype.GetOffenderJoinIndex = function() { return this.$val.GetOffenderJoinIndex(); };
	FireballBullet.ptr.prototype.GetOriginatedRenderFrameId = function() {
		var b;
		b = this;
		return b.BattleAttr.OriginatedRenderFrameId;
	};
	FireballBullet.prototype.GetOriginatedRenderFrameId = function() { return this.$val.GetOriginatedRenderFrameId(); };
	FireballBullet.ptr.prototype.GetStartupFrames = function() {
		var b;
		b = this;
		return b.Bullet.StartupFrames;
	};
	FireballBullet.prototype.GetStartupFrames = function() { return this.$val.GetStartupFrames(); };
	FireballBullet.ptr.prototype.GetActiveFrames = function() {
		var b;
		b = this;
		return b.Bullet.ActiveFrames;
	};
	FireballBullet.prototype.GetActiveFrames = function() { return this.$val.GetActiveFrames(); };
	FireballBullet.ptr.prototype.GetHitboxSizeX = function() {
		var b;
		b = this;
		return b.Bullet.HitboxSizeX;
	};
	FireballBullet.prototype.GetHitboxSizeX = function() { return this.$val.GetHitboxSizeX(); };
	FireballBullet.ptr.prototype.GetHitboxSizeY = function() {
		var b;
		b = this;
		return b.Bullet.HitboxSizeY;
	};
	FireballBullet.prototype.GetHitboxSizeY = function() { return this.$val.GetHitboxSizeY(); };
	FireballBullet.ptr.prototype.GetHitboxOffsetX = function() {
		var b;
		b = this;
		return b.Bullet.HitboxOffsetX;
	};
	FireballBullet.prototype.GetHitboxOffsetX = function() { return this.$val.GetHitboxOffsetX(); };
	FireballBullet.ptr.prototype.GetHitboxOffsetY = function() {
		var b;
		b = this;
		return b.Bullet.HitboxOffsetY;
	};
	FireballBullet.prototype.GetHitboxOffsetY = function() { return this.$val.GetHitboxOffsetY(); };
	FireballBullet.ptr.prototype.GetExplosionFrames = function() {
		var b;
		b = this;
		return b.Bullet.ExplosionFrames;
	};
	FireballBullet.prototype.GetExplosionFrames = function() { return this.$val.GetExplosionFrames(); };
	FireballBullet.ptr.prototype.GetSpeciesId = function() {
		var b;
		b = this;
		return b.Bullet.SpeciesId;
	};
	FireballBullet.prototype.GetSpeciesId = function() { return this.$val.GetSpeciesId(); };
	RoomDownsyncFrame.ptr.prototype.GetId = function() {
		var r;
		r = this;
		return r.Id;
	};
	RoomDownsyncFrame.prototype.GetId = function() { return this.$val.GetId(); };
	RoomDownsyncFrame.ptr.prototype.GetCountdownNanos = function() {
		var r;
		r = this;
		return r.CountdownNanos;
	};
	RoomDownsyncFrame.prototype.GetCountdownNanos = function() { return this.$val.GetCountdownNanos(); };
	RoomDownsyncFrame.ptr.prototype.GetBackendUnconfirmedMask = function() {
		var r;
		r = this;
		return r.BackendUnconfirmedMask;
	};
	RoomDownsyncFrame.prototype.GetBackendUnconfirmedMask = function() { return this.$val.GetBackendUnconfirmedMask(); };
	RoomDownsyncFrame.ptr.prototype.GetBulletLocalIdCounter = function() {
		var r;
		r = this;
		return r.BulletLocalIdCounter;
	};
	RoomDownsyncFrame.prototype.GetBulletLocalIdCounter = function() { return this.$val.GetBulletLocalIdCounter(); };
	RoomDownsyncFrame.ptr.prototype.GetShouldForceResync = function() {
		var r;
		r = this;
		return r.ShouldForceResync;
	};
	RoomDownsyncFrame.prototype.GetShouldForceResync = function() { return this.$val.GetShouldForceResync(); };
	RoomDownsyncFrame.ptr.prototype.GetPlayersArr = function() {
		var r;
		r = this;
		return r.PlayersArr;
	};
	RoomDownsyncFrame.prototype.GetPlayersArr = function() { return this.$val.GetPlayersArr(); };
	RoomDownsyncFrame.ptr.prototype.GetMeleeBullets = function() {
		var r;
		r = this;
		return r.MeleeBullets;
	};
	RoomDownsyncFrame.prototype.GetMeleeBullets = function() { return this.$val.GetMeleeBullets(); };
	RoomDownsyncFrame.ptr.prototype.GetFireballBullets = function() {
		var r;
		r = this;
		return r.FireballBullets;
	};
	RoomDownsyncFrame.prototype.GetFireballBullets = function() { return this.$val.GetFireballBullets(); };
	intAbs = function(x) {
		var x;
		if (x < 0) {
			return -x;
		}
		return x;
	};
	ShouldGenerateInputFrameUpsync = function(renderFrameId) {
		var renderFrameId;
		return (((renderFrameId & 3)) === 0);
	};
	$pkg.ShouldGenerateInputFrameUpsync = ShouldGenerateInputFrameUpsync;
	ConvertToDelayedInputFrameId = function(renderFrameId) {
		var renderFrameId;
		if (renderFrameId < 6) {
			return 0;
		}
		return (((renderFrameId - 6 >> 0)) >> 2 >> 0);
	};
	$pkg.ConvertToDelayedInputFrameId = ConvertToDelayedInputFrameId;
	ConvertToNoDelayInputFrameId = function(renderFrameId) {
		var renderFrameId;
		return (renderFrameId >> 2 >> 0);
	};
	$pkg.ConvertToNoDelayInputFrameId = ConvertToNoDelayInputFrameId;
	ConvertToFirstUsedRenderFrameId = function(inputFrameId) {
		var inputFrameId;
		return (((inputFrameId << 2 >> 0)) + 6 >> 0);
	};
	$pkg.ConvertToFirstUsedRenderFrameId = ConvertToFirstUsedRenderFrameId;
	ConvertToLastUsedRenderFrameId = function(inputFrameId) {
		var inputFrameId;
		return (((((inputFrameId << 2 >> 0)) + 6 >> 0) + 4 >> 0) - 1 >> 0);
	};
	$pkg.ConvertToLastUsedRenderFrameId = ConvertToLastUsedRenderFrameId;
	decodeInput = function(encodedInput) {
		var btnALevel, btnBLevel, encodedDirection, encodedInput, x, x$1, x$2, x$3;
		encodedDirection = new $Uint64(encodedInput.$high & 0, (encodedInput.$low & 15) >>> 0);
		btnALevel = (((x = $shiftRightUint64(encodedInput, 4), new $Uint64(x.$high & 0, (x.$low & 1) >>> 0)).$low >> 0));
		btnBLevel = (((x$1 = $shiftRightUint64(encodedInput, 5), new $Uint64(x$1.$high & 0, (x$1.$low & 1) >>> 0)).$low >> 0));
		return new InputFrameDecoded.ptr((x$2 = (($flatten64(encodedDirection) < 0 || $flatten64(encodedDirection) >= $pkg.DIRECTION_DECODER.$length) ? ($throwRuntimeError("index out of range"), undefined) : $pkg.DIRECTION_DECODER.$array[$pkg.DIRECTION_DECODER.$offset + $flatten64(encodedDirection)]), (0 >= x$2.$length ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + 0])), (x$3 = (($flatten64(encodedDirection) < 0 || $flatten64(encodedDirection) >= $pkg.DIRECTION_DECODER.$length) ? ($throwRuntimeError("index out of range"), undefined) : $pkg.DIRECTION_DECODER.$array[$pkg.DIRECTION_DECODER.$offset + $flatten64(encodedDirection)]), (1 >= x$3.$length ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + 1])), btnALevel, btnBLevel);
	};
	calcPushbacks = function(oldDx, oldDy, playerShape, barrierShape) {
		var {$24r, $24r$1, _tmp, _tmp$1, _tuple, barrierShape, oldDx, oldDy, origX, origY, overlapResult, overlapped, playerShape, pushbackX, pushbackY, $s, $deferred, $r, $c} = $restore(this, {oldDx, oldDy, playerShape, barrierShape});
		/* */ $s = $s || 0; var $err = null; try { s: while (true) { switch ($s) { case 0: $deferred = []; $curGoroutine.deferStack.push($deferred);
		origX = [origX];
		origY = [origY];
		playerShape = [playerShape];
		_tuple = playerShape[0].Position();
		origX[0] = _tuple[0];
		origY[0] = _tuple[1];
		$deferred.push([(function(origX, origY, playerShape) { return function() {
			playerShape[0].SetPosition(origX[0], origY[0]);
		}; })(origX, origY, playerShape), []]);
		playerShape[0].SetPosition(origX[0] + oldDx, origY[0] + oldDy);
		overlapResult = new SatResult.ptr(0, 0, 0, true, true, new resolv.Vector([0, 0]));
		overlapped = isPolygonPairOverlapped(playerShape[0], barrierShape, overlapResult);
		/* */ if (overlapped) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (overlapped) { */ case 1:
			_tmp = overlapResult.Overlap * overlapResult.OverlapX;
			_tmp$1 = overlapResult.Overlap * overlapResult.OverlapY;
			pushbackX = _tmp;
			pushbackY = _tmp$1;
			$24r = [true, pushbackX, pushbackY, overlapResult];
			$s = 4; case 4: return $24r;
		/* } else { */ case 2:
			$24r$1 = [false, 0, 0, overlapResult];
			$s = 5; case 5: return $24r$1;
		/* } */ case 3:
		$s = -1; return [false, 0, 0, ptrType$4.nil];
		/* */ } return; } } catch(err) { $err = err; $s = -1; return [false, 0, 0, ptrType$4.nil]; } finally { $callDeferred($deferred, $err); if($curGoroutine.asleep) { var $f = {$blk: calcPushbacks, $c: true, $r, $24r, $24r$1, _tmp, _tmp$1, _tuple, barrierShape, oldDx, oldDy, origX, origY, overlapResult, overlapped, playerShape, pushbackX, pushbackY, $s, $deferred};return $f; } }
	};
	isPolygonPairOverlapped = function(a, b, result) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, a, aCnt, aPoint, axis, axis$1, b, bCnt, bPoint, dx, dx$1, dy, dy$1, i, i$1, result, u, u$1, v, v$1;
		_tmp = a.Points.Cnt;
		_tmp$1 = b.Points.Cnt;
		aCnt = _tmp;
		bCnt = _tmp$1;
		if ((1 === aCnt) && (1 === bCnt)) {
			if (!(ptrType$4.nil === result)) {
				result.Overlap = 0;
			}
			aPoint = a.GetPointByOffset(0);
			bPoint = b.GetPointByOffset(0);
			return ((0 >= aPoint.$length ? ($throwRuntimeError("index out of range"), undefined) : aPoint.$array[aPoint.$offset + 0]) === (0 >= bPoint.$length ? ($throwRuntimeError("index out of range"), undefined) : bPoint.$array[bPoint.$offset + 0])) && ((1 >= aPoint.$length ? ($throwRuntimeError("index out of range"), undefined) : aPoint.$array[aPoint.$offset + 1]) === (1 >= bPoint.$length ? ($throwRuntimeError("index out of range"), undefined) : bPoint.$array[bPoint.$offset + 1]));
		}
		if (1 < aCnt) {
			i = 0;
			while (true) {
				if (!(i < a.Points.Cnt)) { break; }
				_tmp$2 = a.GetPointByOffset(i);
				_tmp$3 = a.GetPointByOffset(0);
				u = _tmp$2;
				v = _tmp$3;
				if (!((i === (a.Points.Cnt - 1 >> 0)))) {
					v = a.GetPointByOffset(i + 1 >> 0);
				}
				dy = (1 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 1]) - (1 >= u.$length ? ($throwRuntimeError("index out of range"), undefined) : u.$array[u.$offset + 1]);
				dx = (0 >= v.$length ? ($throwRuntimeError("index out of range"), undefined) : v.$array[v.$offset + 0]) - (0 >= u.$length ? ($throwRuntimeError("index out of range"), undefined) : u.$array[u.$offset + 0]);
				axis = new resolv.Vector([dy, -dx]).Unit();
				if (isPolygonPairSeparatedByDir(a, b, axis, result)) {
					return false;
				}
				i = i + (1) >> 0;
			}
		}
		if (1 < bCnt) {
			i$1 = 0;
			while (true) {
				if (!(i$1 < b.Points.Cnt)) { break; }
				_tmp$4 = b.GetPointByOffset(i$1);
				_tmp$5 = b.GetPointByOffset(0);
				u$1 = _tmp$4;
				v$1 = _tmp$5;
				if (!((i$1 === (b.Points.Cnt - 1 >> 0)))) {
					v$1 = b.GetPointByOffset(i$1 + 1 >> 0);
				}
				dy$1 = (1 >= v$1.$length ? ($throwRuntimeError("index out of range"), undefined) : v$1.$array[v$1.$offset + 1]) - (1 >= u$1.$length ? ($throwRuntimeError("index out of range"), undefined) : u$1.$array[u$1.$offset + 1]);
				dx$1 = (0 >= v$1.$length ? ($throwRuntimeError("index out of range"), undefined) : v$1.$array[v$1.$offset + 0]) - (0 >= u$1.$length ? ($throwRuntimeError("index out of range"), undefined) : u$1.$array[u$1.$offset + 0]);
				axis$1 = new resolv.Vector([dy$1, -dx$1]).Unit();
				if (isPolygonPairSeparatedByDir(a, b, axis$1, result)) {
					return false;
				}
				i$1 = i$1 + (1) >> 0;
			}
		}
		return true;
	};
	IsGeneralBulletActive = function(blState, originatedRenderFrameId, startupFrames, activeFrames, renderFrameId) {
		var activeFrames, blState, originatedRenderFrameId, renderFrameId, startupFrames;
		if (2 === blState) {
			return false;
		}
		return ((originatedRenderFrameId + startupFrames >> 0) < renderFrameId) && (((originatedRenderFrameId + startupFrames >> 0) + activeFrames >> 0) > renderFrameId);
	};
	$pkg.IsGeneralBulletActive = IsGeneralBulletActive;
	IsMeleeBulletActive = function(meleeBullet, currRenderFrame) {
		var currRenderFrame, meleeBullet;
		return IsGeneralBulletActive(meleeBullet.BlState, meleeBullet.BattleAttr.OriginatedRenderFrameId, meleeBullet.Bullet.StartupFrames, meleeBullet.Bullet.ActiveFrames, currRenderFrame.Id);
	};
	$pkg.IsMeleeBulletActive = IsMeleeBulletActive;
	IsMeleeBulletAlive = function(meleeBullet, currRenderFrame) {
		var currRenderFrame, meleeBullet;
		if (2 === meleeBullet.BlState) {
			return meleeBullet.FramesInBlState < meleeBullet.Bullet.ExplosionFrames;
		}
		return ((meleeBullet.BattleAttr.OriginatedRenderFrameId + meleeBullet.Bullet.StartupFrames >> 0) + meleeBullet.Bullet.ActiveFrames >> 0) > currRenderFrame.Id;
	};
	$pkg.IsMeleeBulletAlive = IsMeleeBulletAlive;
	IsFireballBulletActive = function(fireballBullet, currRenderFrame) {
		var currRenderFrame, fireballBullet;
		return IsGeneralBulletActive(fireballBullet.BlState, fireballBullet.BattleAttr.OriginatedRenderFrameId, fireballBullet.Bullet.StartupFrames, fireballBullet.Bullet.ActiveFrames, currRenderFrame.Id);
	};
	$pkg.IsFireballBulletActive = IsFireballBulletActive;
	IsFireballBulletAlive = function(fireballBullet, currRenderFrame) {
		var currRenderFrame, fireballBullet;
		if (2 === fireballBullet.BlState) {
			return fireballBullet.FramesInBlState < fireballBullet.Bullet.ExplosionFrames;
		}
		return ((fireballBullet.BattleAttr.OriginatedRenderFrameId + fireballBullet.Bullet.StartupFrames >> 0) + fireballBullet.Bullet.ActiveFrames >> 0) > currRenderFrame.Id;
	};
	$pkg.IsFireballBulletAlive = IsFireballBulletAlive;
	isPolygonPairSeparatedByDir = function(a, b, e, result) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, a, aEnd, aStart, absoluteOverlap, b, bEnd, bStart, currentOverlap, dot, dot$1, e, i, i$1, option1, option1$1, option2, option2$1, overlap, p, p$1, result, sign, x, x$1;
		_tmp = 1.7e+308;
		_tmp$1 = -1.7e+308;
		_tmp$2 = 1.7e+308;
		_tmp$3 = -1.7e+308;
		aStart = _tmp;
		aEnd = _tmp$1;
		bStart = _tmp$2;
		bEnd = _tmp$3;
		i = 0;
		while (true) {
			if (!(i < a.Points.Cnt)) { break; }
			p = a.GetPointByOffset(i);
			dot = ((0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0]) + a.X) * (0 >= e.$length ? ($throwRuntimeError("index out of range"), undefined) : e.$array[e.$offset + 0]) + ((1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1]) + a.Y) * (1 >= e.$length ? ($throwRuntimeError("index out of range"), undefined) : e.$array[e.$offset + 1]);
			if (aStart > dot) {
				aStart = dot;
			}
			if (aEnd < dot) {
				aEnd = dot;
			}
			i = i + (1) >> 0;
		}
		i$1 = 0;
		while (true) {
			if (!(i$1 < b.Points.Cnt)) { break; }
			p$1 = b.GetPointByOffset(i$1);
			dot$1 = ((0 >= p$1.$length ? ($throwRuntimeError("index out of range"), undefined) : p$1.$array[p$1.$offset + 0]) + b.X) * (0 >= e.$length ? ($throwRuntimeError("index out of range"), undefined) : e.$array[e.$offset + 0]) + ((1 >= p$1.$length ? ($throwRuntimeError("index out of range"), undefined) : p$1.$array[p$1.$offset + 1]) + b.Y) * (1 >= e.$length ? ($throwRuntimeError("index out of range"), undefined) : e.$array[e.$offset + 1]);
			if (bStart > dot$1) {
				bStart = dot$1;
			}
			if (bEnd < dot$1) {
				bEnd = dot$1;
			}
			i$1 = i$1 + (1) >> 0;
		}
		if (aStart > bEnd || aEnd < bStart) {
			return true;
		}
		if (!(ptrType$4.nil === result)) {
			overlap = 0;
			if (aStart < bStart) {
				result.AContainedInB = false;
				if (aEnd < bEnd) {
					overlap = aEnd - bStart;
					result.BContainedInA = false;
				} else {
					option1 = aEnd - bStart;
					option2 = bEnd - aStart;
					if (option1 < option2) {
						overlap = option1;
					} else {
						overlap = -option2;
					}
				}
			} else {
				result.BContainedInA = false;
				if (aEnd > bEnd) {
					overlap = aStart - bEnd;
					result.AContainedInB = false;
				} else {
					option1$1 = aEnd - bStart;
					option2$1 = bEnd - aStart;
					if (option1$1 < option2$1) {
						overlap = option1$1;
					} else {
						overlap = -option2$1;
					}
				}
			}
			currentOverlap = result.Overlap;
			absoluteOverlap = overlap;
			if (overlap < 0) {
				absoluteOverlap = -overlap;
			}
			if (((0 === (x = result.Axis, (0 >= x.$length ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + 0]))) && (0 === (x$1 = result.Axis, (1 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 1])))) || currentOverlap > absoluteOverlap) {
				sign = 1;
				if (overlap < 0) {
					sign = -1;
				}
				result.Overlap = absoluteOverlap;
				result.OverlapX = (0 >= e.$length ? ($throwRuntimeError("index out of range"), undefined) : e.$array[e.$offset + 0]) * sign;
				result.OverlapY = (1 >= e.$length ? ($throwRuntimeError("index out of range"), undefined) : e.$array[e.$offset + 1]) * sign;
			}
			result.Axis = e;
		}
		return false;
	};
	WorldToVirtualGridPos = function(wx, wy) {
		var virtualGridX, virtualGridY, wx, wy;
		virtualGridX = ((math.Round(wx * 10) >> 0));
		virtualGridY = ((math.Round(wy * 10) >> 0));
		return [virtualGridX, virtualGridY];
	};
	$pkg.WorldToVirtualGridPos = WorldToVirtualGridPos;
	VirtualGridToWorldPos = function(vx, vy) {
		var vx, vy, wx, wy;
		wx = (vx) * 0.1;
		wy = (vy) * 0.1;
		return [wx, wy];
	};
	$pkg.VirtualGridToWorldPos = VirtualGridToWorldPos;
	WorldToPolygonColliderBLPos = function(wx, wy, halfBoundingW, halfBoundingH, topPadding, bottomPadding, leftPadding, rightPadding, collisionSpaceOffsetX, collisionSpaceOffsetY) {
		var bottomPadding, collisionSpaceOffsetX, collisionSpaceOffsetY, halfBoundingH, halfBoundingW, leftPadding, rightPadding, topPadding, wx, wy;
		return [wx - halfBoundingW - leftPadding + collisionSpaceOffsetX, wy - halfBoundingH - bottomPadding + collisionSpaceOffsetY];
	};
	$pkg.WorldToPolygonColliderBLPos = WorldToPolygonColliderBLPos;
	PolygonColliderBLToWorldPos = function(cx, cy, halfBoundingW, halfBoundingH, topPadding, bottomPadding, leftPadding, rightPadding, collisionSpaceOffsetX, collisionSpaceOffsetY) {
		var bottomPadding, collisionSpaceOffsetX, collisionSpaceOffsetY, cx, cy, halfBoundingH, halfBoundingW, leftPadding, rightPadding, topPadding;
		return [cx + halfBoundingW + leftPadding - collisionSpaceOffsetX, cy + halfBoundingH + bottomPadding - collisionSpaceOffsetY];
	};
	$pkg.PolygonColliderBLToWorldPos = PolygonColliderBLToWorldPos;
	PolygonColliderBLToVirtualGridPos = function(cx, cy, halfBoundingW, halfBoundingH, topPadding, bottomPadding, leftPadding, rightPadding, collisionSpaceOffsetX, collisionSpaceOffsetY) {
		var _tuple, bottomPadding, collisionSpaceOffsetX, collisionSpaceOffsetY, cx, cy, halfBoundingH, halfBoundingW, leftPadding, rightPadding, topPadding, wx, wy;
		_tuple = PolygonColliderBLToWorldPos(cx, cy, halfBoundingW, halfBoundingH, topPadding, bottomPadding, leftPadding, rightPadding, collisionSpaceOffsetX, collisionSpaceOffsetY);
		wx = _tuple[0];
		wy = _tuple[1];
		return WorldToVirtualGridPos(wx, wy);
	};
	$pkg.PolygonColliderBLToVirtualGridPos = PolygonColliderBLToVirtualGridPos;
	calcHardPushbacksNorms = function(joinIndex, currPlayerDownsync, thatPlayerInNextFrame, playerCollider, playerShape, snapIntoPlatformOverlap, effPushback, hardPushbackNorms, collision) {
		var {_r, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tuple, barrierShape, collided, collision, currPlayerDownsync, effPushback, hardPushbackNorms, isBarrier, joinIndex, obj, overlapResult, overlapped, playerCollider, playerShape, pushbackX, pushbackY, retCnt, snapIntoPlatformOverlap, thatPlayerInNextFrame, virtualGripToWall, xfac, $s, $r, $c} = $restore(this, {joinIndex, currPlayerDownsync, thatPlayerInNextFrame, playerCollider, playerShape, snapIntoPlatformOverlap, effPushback, hardPushbackNorms, collision});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		virtualGripToWall = 0;
		if ((16 === currPlayerDownsync.CharacterState) && (0 === thatPlayerInNextFrame.VelX) && (currPlayerDownsync.DirX === thatPlayerInNextFrame.DirX)) {
			xfac = 1;
			if (0 > thatPlayerInNextFrame.DirX) {
				xfac = -xfac;
			}
			virtualGripToWall = xfac * (currPlayerDownsync.Speed) * 0.1;
		}
		retCnt = 0;
		collided = playerCollider.CheckAllWithHolder(virtualGripToWall, 0, collision);
		if (!collided) {
			$s = -1; return retCnt;
		}
		/* while (true) { */ case 1:
			obj = collision.PopFirstCollidedObject();
			if (ptrType$5.nil === obj) {
				/* break; */ $s = 2; continue;
			}
			isBarrier = false;
			_ref = obj.Data;
			if ($assertType(_ref, ptrType$6, true)[1] || $assertType(_ref, ptrType$3, true)[1] || $assertType(_ref, ptrType$7, true)[1]) {
			} else {
				isBarrier = true;
			}
			if (!isBarrier) {
				/* continue; */ $s = 1; continue;
			}
			barrierShape = $assertType(obj.Shape, ptrType$8);
			_r = calcPushbacks(0, 0, playerShape, barrierShape); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_tuple = _r;
			overlapped = _tuple[0];
			pushbackX = _tuple[1];
			pushbackY = _tuple[2];
			overlapResult = _tuple[3];
			if (!overlapped) {
				/* continue; */ $s = 1; continue;
			}
			_tmp = (overlapResult.Overlap - snapIntoPlatformOverlap) * overlapResult.OverlapX;
			_tmp$1 = (overlapResult.Overlap - snapIntoPlatformOverlap) * overlapResult.OverlapY;
			pushbackX = _tmp;
			pushbackY = _tmp$1;
			_tmp$2 = overlapResult.OverlapX;
			_tmp$3 = overlapResult.OverlapY;
			((retCnt < 0 || retCnt >= hardPushbackNorms.$length) ? ($throwRuntimeError("index out of range"), undefined) : hardPushbackNorms.$array[hardPushbackNorms.$offset + retCnt]).X = _tmp$2;
			((retCnt < 0 || retCnt >= hardPushbackNorms.$length) ? ($throwRuntimeError("index out of range"), undefined) : hardPushbackNorms.$array[hardPushbackNorms.$offset + retCnt]).Y = _tmp$3;
			effPushback.X = effPushback.X + (pushbackX);
			effPushback.Y = effPushback.Y + (pushbackY);
			retCnt = retCnt + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return retCnt;
		/* */ } return; } var $f = {$blk: calcHardPushbacksNorms, $c: true, $r, _r, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tuple, barrierShape, collided, collision, currPlayerDownsync, effPushback, hardPushbackNorms, isBarrier, joinIndex, obj, overlapResult, overlapped, playerCollider, playerShape, pushbackX, pushbackY, retCnt, snapIntoPlatformOverlap, thatPlayerInNextFrame, virtualGripToWall, xfac, $s};return $f;
	};
	deriveOpPattern = function(currPlayerDownsync, thatPlayerInNextFrame, currRenderFrame, chConfig, inputsBuffer) {
		var _entry, _entry$1, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tuple, _tuple$1, canJumpWithinInertia, chConfig, currPlayerDownsync, currRenderFrame, decodedInput, delayedInputFrameId, delayedInputFrameIdForPrevRdf, delayedInputList, delayedInputListForPrevRdf, effDx, effDy, existent, existent$1, inputsBuffer, joinIndex, jumpedOrNot, patternId, prevBtnALevel, prevBtnBLevel, prevDecodedInput, thatPlayerInNextFrame, x, x$1;
		delayedInputFrameId = ConvertToDelayedInputFrameId(currRenderFrame.Id);
		delayedInputFrameIdForPrevRdf = ConvertToDelayedInputFrameId(currRenderFrame.Id - 1 >> 0);
		if (0 >= delayedInputFrameId) {
			return [-2, false, 0, 0];
		}
		_tuple = (_entry = noOpSet[$Int32.keyFor(currPlayerDownsync.CharacterState)], _entry !== undefined ? [_entry.v, true] : [false, false]);
		existent = _tuple[1];
		if (existent) {
			return [-2, false, 0, 0];
		}
		delayedInputList = $assertType(inputsBuffer.GetByFrameId(delayedInputFrameId), ptrType$9).InputList;
		delayedInputListForPrevRdf = sliceType$3.nil;
		if (0 < delayedInputFrameIdForPrevRdf) {
			delayedInputListForPrevRdf = $assertType(inputsBuffer.GetByFrameId(delayedInputFrameIdForPrevRdf), ptrType$9).InputList;
		}
		jumpedOrNot = false;
		joinIndex = currPlayerDownsync.JoinIndex;
		decodedInput = decodeInput((x = joinIndex - 1 >> 0, ((x < 0 || x >= delayedInputList.$length) ? ($throwRuntimeError("index out of range"), undefined) : delayedInputList.$array[delayedInputList.$offset + x])));
		_tmp = 0;
		_tmp$1 = 0;
		effDx = _tmp;
		effDy = _tmp$1;
		_tmp$2 = 0;
		_tmp$3 = 0;
		prevBtnALevel = _tmp$2;
		prevBtnBLevel = _tmp$3;
		if (!(sliceType$3.nil === delayedInputListForPrevRdf)) {
			prevDecodedInput = decodeInput((x$1 = joinIndex - 1 >> 0, ((x$1 < 0 || x$1 >= delayedInputListForPrevRdf.$length) ? ($throwRuntimeError("index out of range"), undefined) : delayedInputListForPrevRdf.$array[delayedInputListForPrevRdf.$offset + x$1])));
			prevBtnALevel = prevDecodedInput.BtnALevel;
			prevBtnBLevel = prevDecodedInput.BtnBLevel;
		}
		if (0 === currPlayerDownsync.FramesToRecover) {
			_tmp$4 = decodedInput.Dx;
			_tmp$5 = decodedInput.Dy;
			effDx = _tmp$4;
			effDy = _tmp$5;
		}
		patternId = -1;
		canJumpWithinInertia = currPlayerDownsync.CapturedByInertia && (((chConfig.InertiaFramesToRecover >> 1 >> 0)) > currPlayerDownsync.FramesToRecover);
		if ((0 === currPlayerDownsync.FramesToRecover) || canJumpWithinInertia) {
			if (decodedInput.BtnBLevel > prevBtnBLevel) {
				if (chConfig.DashingEnabled && 0 > decodedInput.Dy && !((15 === currPlayerDownsync.CharacterState))) {
					patternId = 5;
				} else {
					_tuple$1 = (_entry$1 = inAirSet[$Int32.keyFor(currPlayerDownsync.CharacterState)], _entry$1 !== undefined ? [_entry$1.v, true] : [false, false]);
					existent$1 = _tuple$1[1];
					if (!existent$1) {
						jumpedOrNot = true;
					} else if (16 === currPlayerDownsync.CharacterState) {
						jumpedOrNot = true;
					}
				}
			}
		}
		if (-1 === patternId) {
			if (0 < decodedInput.BtnALevel) {
				if (decodedInput.BtnALevel > prevBtnALevel) {
					if (0 > decodedInput.Dy) {
						patternId = 3;
					} else if (0 < decodedInput.Dy) {
						patternId = 2;
					} else {
						patternId = 1;
					}
				} else {
					patternId = 4;
				}
			}
		}
		return [patternId, jumpedOrNot, effDx, effDy];
	};
	ApplyInputFrameDownsyncDynamicsOnSingleRenderFrame = function(inputsBuffer, currRenderFrameId, collisionSys, collisionSysMap, collisionSpaceOffsetX, collisionSpaceOffsetY, chConfigsOrderedByJoinIndex, renderFrameBuffer, collision, effPushbacks, hardPushbackNormsArr, jumpedOrNotList, dynamicRectangleColliders) {
		var {_1, _2, _3, _4, _entry, _entry$1, _entry$2, _entry$3, _entry$4, _entry$5, _entry$6, _i, _i$1, _i$2, _i$3, _i$4, _i$5, _i$6, _index, _index$1, _index$2, _r, _r$1, _r$2, _r$3, _r$4, _ref, _ref$1, _ref$10, _ref$11, _ref$2, _ref$3, _ref$4, _ref$5, _ref$6, _ref$7, _ref$8, _ref$9, _tmp, _tmp$1, _tmp$10, _tmp$11, _tmp$12, _tmp$13, _tmp$14, _tmp$15, _tmp$16, _tmp$17, _tmp$18, _tmp$19, _tmp$2, _tmp$20, _tmp$21, _tmp$22, _tmp$23, _tmp$24, _tmp$25, _tmp$26, _tmp$27, _tmp$28, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tmp$9, _tuple, _tuple$1, _tuple$10, _tuple$11, _tuple$12, _tuple$13, _tuple$14, _tuple$15, _tuple$16, _tuple$17, _tuple$2, _tuple$3, _tuple$4, _tuple$5, _tuple$6, _tuple$7, _tuple$8, _tuple$9, alignedWithInertia, atkedPlayerInNextFrame, bShape, bulletBattleAttr, bulletCollider, bulletLocalId, bulletShape, bulletStaticAttr, bulletWx, bulletWx$1, bulletWy, bulletWy$1, candidate, chConfig, chConfig$1, chConfig$2, chConfigsOrderedByJoinIndex, collided, collided$1, colliderCnt, colliderHeight, colliderWidth, colliderWorldHeight, colliderWorldWidth, collision, collisionSpaceOffsetX, collisionSpaceOffsetY, collisionSys, collisionSysMap, currPlayerDownsync, currPlayerDownsync$1, currPlayerDownsync$2, currPlayerDownsync$3, currPlayerDownsync$4, currRenderFrame, currRenderFrameId, defenderShape, dynamicCollider, dynamicRectangleColliders, effDx, effDy, effPushbacks, exactTurningAround, existent, existent$1, existent$2, existent$3, existent$4, existent$5, existent$6, exploded, explodedOnAnotherPlayer, fallStopping, fireballBullet, fireballBulletCnt, halfColliderHeightDiff, halfColliderWidthDiff, halfColliderWorldHeightDiff, hardPushbackCnt, hardPushbackNorm, hardPushbackNorm$1, hardPushbackNormsArr, hasBeenOnWallChState, hasBeenOnWallCollisionResultForSameChState, hasLockVel, hitboxSizeWx, hitboxSizeWx$1, hitboxSizeWy, hitboxSizeWy$1, i, i$1, i$2, i$3, i$4, i$5, i$6, i$7, i$8, inputsBuffer, isAnotherPlayer, isBarrier, isBullet, isWallJumping, joinIndex, joinIndex$1, joinIndex$2, joinIndex$3, jumpedOrNot, jumpedOrNotList, landedOnGravityPushback, meleeBullet, meleeBulletCnt, newBulletCollider, newBulletCollider$1, newVx, newVy, nextRenderFrameFireballBullets, nextRenderFrameId, nextRenderFrameMeleeBullets, nextRenderFramePlayers, normAlignmentWithGravity, normAlignmentWithHorizon1, normAlignmentWithHorizon2, obj, obj$1, offender, offender$1, offender$2, oldFramesToRecover, oldNextCharacterState, overlapResult, overlapped, overlapped$1, patternId, playerCollider, playerCollider$1, playerCollider$2, playerShape, prevCapturedByInertia, prevFireball, prevMelee, projectedMagnitude, pushbackVelX, pushbackVelY, pushbackX, pushbackY, renderFrameBuffer, ret, roomCapacity, skillConfig, skillId, stoppingFromWalking, t, t$1, thatPlayerInNextFrame, thatPlayerInNextFrame$1, thatPlayerInNextFrame$2, thatPlayerInNextFrame$3, v, v$1, v$2, v$3, v$4, v$5, v$6, v$7, v$8, wx, wy, x, x$1, x$10, x$11, x$12, x$13, x$14, x$15, x$16, x$17, x$18, x$19, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, xfac, xfac$1, xfac$2, xfac$3, xfac$4, $s, $r, $c} = $restore(this, {inputsBuffer, currRenderFrameId, collisionSys, collisionSysMap, collisionSpaceOffsetX, collisionSpaceOffsetY, chConfigsOrderedByJoinIndex, renderFrameBuffer, collision, effPushbacks, hardPushbackNormsArr, jumpedOrNotList, dynamicRectangleColliders});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		currRenderFrame = $assertType(renderFrameBuffer.GetByFrameId(currRenderFrameId), ptrType$10);
		nextRenderFrameId = currRenderFrameId + 1 >> 0;
		roomCapacity = currRenderFrame.PlayersArr.$length;
		ret = ptrType$10.nil;
		candidate = renderFrameBuffer.GetByFrameId(nextRenderFrameId);
		if ($interfaceIsEqual($ifaceNil, candidate)) {
			if (nextRenderFrameId === renderFrameBuffer.EdFrameId) {
				renderFrameBuffer.DryPut();
				candidate = renderFrameBuffer.GetByFrameId(nextRenderFrameId);
				if ($interfaceIsEqual($ifaceNil, candidate)) {
					ret = NewPreallocatedRoomDownsyncFrame(roomCapacity, 64, 64);
					renderFrameBuffer.SetByFrameId(ret, nextRenderFrameId);
				} else {
					ret = $assertType(candidate, ptrType$10);
				}
			} else {
				$panic(new $String("Invalid nextRenderFrameId=" + ($encodeRune(nextRenderFrameId)) + "!"));
			}
		} else {
			ret = $assertType(candidate, ptrType$10);
		}
		nextRenderFramePlayers = ret.PlayersArr;
		_ref = currRenderFrame.PlayersArr;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			currPlayerDownsync = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).Id = currPlayerDownsync.Id;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).VirtualGridX = currPlayerDownsync.VirtualGridX;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).VirtualGridY = currPlayerDownsync.VirtualGridY;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).DirX = currPlayerDownsync.DirX;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).DirY = currPlayerDownsync.DirY;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).VelX = currPlayerDownsync.VelX;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).VelY = currPlayerDownsync.VelY;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).CharacterState = currPlayerDownsync.CharacterState;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).InAir = true;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).OnWall = false;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).Speed = currPlayerDownsync.Speed;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).BattleState = currPlayerDownsync.BattleState;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).Score = currPlayerDownsync.Score;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).Removed = currPlayerDownsync.Removed;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).JoinIndex = currPlayerDownsync.JoinIndex;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).Hp = currPlayerDownsync.Hp;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).MaxHp = currPlayerDownsync.MaxHp;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesToRecover = currPlayerDownsync.FramesToRecover - 1 >> 0;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesInChState = currPlayerDownsync.FramesInChState + 1 >> 0;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).ActiveSkillId = currPlayerDownsync.ActiveSkillId;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).ActiveSkillHit = currPlayerDownsync.ActiveSkillHit;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesInvinsible = currPlayerDownsync.FramesInvinsible - 1 >> 0;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).BulletTeamId = currPlayerDownsync.BulletTeamId;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).ChCollisionTeamId = currPlayerDownsync.ChCollisionTeamId;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).RevivalVirtualGridX = currPlayerDownsync.RevivalVirtualGridX;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).RevivalVirtualGridY = currPlayerDownsync.RevivalVirtualGridY;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).ColliderRadius = currPlayerDownsync.ColliderRadius;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).OnWallNormX = currPlayerDownsync.OnWallNormX;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).OnWallNormY = currPlayerDownsync.OnWallNormY;
			((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).CapturedByInertia = currPlayerDownsync.CapturedByInertia;
			if (((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesToRecover < 0) {
				((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesToRecover = 0;
			}
			if (((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesInvinsible < 0) {
				((i < 0 || i >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i]).FramesInvinsible = 0;
			}
			_i++;
		}
		meleeBulletCnt = 0;
		nextRenderFrameMeleeBullets = ret.MeleeBullets;
		fireballBulletCnt = 0;
		nextRenderFrameFireballBullets = ret.FireballBullets;
		bulletLocalId = currRenderFrame.BulletLocalIdCounter;
		_ref$1 = currRenderFrame.PlayersArr;
		_i$1 = 0;
		/* while (true) { */ case 1:
			/* if (!(_i$1 < _ref$1.$length)) { break; } */ if(!(_i$1 < _ref$1.$length)) { $s = 2; continue; }
			i$1 = _i$1;
			currPlayerDownsync$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			chConfig = ((i$1 < 0 || i$1 >= chConfigsOrderedByJoinIndex.$length) ? ($throwRuntimeError("index out of range"), undefined) : chConfigsOrderedByJoinIndex.$array[chConfigsOrderedByJoinIndex.$offset + i$1]);
			thatPlayerInNextFrame = ((i$1 < 0 || i$1 >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i$1]);
			_tuple = deriveOpPattern(currPlayerDownsync$1, thatPlayerInNextFrame, currRenderFrame, chConfig, inputsBuffer);
			patternId = _tuple[0];
			jumpedOrNot = _tuple[1];
			effDx = _tuple[2];
			effDy = _tuple[3];
			((i$1 < 0 || i$1 >= jumpedOrNotList.$length) ? ($throwRuntimeError("index out of range"), undefined) : jumpedOrNotList.$array[jumpedOrNotList.$offset + i$1] = jumpedOrNot);
			joinIndex = currPlayerDownsync$1.JoinIndex;
			_r = chConfig.SkillMapper(patternId, currPlayerDownsync$1); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			skillId = _r;
			_tuple$1 = (_entry = skills[$Int.keyFor(skillId)], _entry !== undefined ? [_entry.v, true] : [ptrType$2.nil, false]);
			skillConfig = _tuple$1[0];
			existent = _tuple$1[1];
			if (existent) {
				thatPlayerInNextFrame.ActiveSkillId = ((skillId >> 0));
				thatPlayerInNextFrame.ActiveSkillHit = 0;
				thatPlayerInNextFrame.FramesToRecover = skillConfig.RecoveryFrames;
				xfac = 1;
				if (0 > thatPlayerInNextFrame.DirX) {
					xfac = -xfac;
				}
				hasLockVel = false;
				_ref$2 = (x = skillConfig.Hits, x$1 = thatPlayerInNextFrame.ActiveSkillHit, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1]));
				if ($assertType(_ref$2, ptrType$3, true)[1]) {
					v = _ref$2.$val;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).BlState = 0;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).FramesInBlState = 0;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).Bullet = v.Bullet;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).BattleAttr.BulletLocalId = bulletLocalId;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).BattleAttr.OriginatedRenderFrameId = currRenderFrame.Id;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).BattleAttr.OffenderJoinIndex = joinIndex;
					((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).BattleAttr.TeamId = currPlayerDownsync$1.BulletTeamId;
					bulletLocalId = bulletLocalId + (1) >> 0;
					meleeBulletCnt = meleeBulletCnt + (1) >> 0;
					if (!((-1 === v.Bullet.SelfLockVelX))) {
						hasLockVel = true;
						thatPlayerInNextFrame.VelX = $imul(xfac, v.Bullet.SelfLockVelX);
					}
					if (!((-1 === v.Bullet.SelfLockVelY))) {
						hasLockVel = true;
						thatPlayerInNextFrame.VelY = v.Bullet.SelfLockVelY;
					}
				} else if ($assertType(_ref$2, ptrType$7, true)[1]) {
					v$1 = _ref$2.$val;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).BlState = 0;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).FramesInBlState = 0;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).Bullet = v$1.Bullet;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).BattleAttr.BulletLocalId = bulletLocalId;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).BattleAttr.OriginatedRenderFrameId = currRenderFrame.Id;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).BattleAttr.OffenderJoinIndex = joinIndex;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).BattleAttr.TeamId = currPlayerDownsync$1.BulletTeamId;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).VirtualGridX = currPlayerDownsync$1.VirtualGridX + ($imul(xfac, v$1.Bullet.HitboxOffsetX)) >> 0;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).VirtualGridY = currPlayerDownsync$1.VirtualGridY + v$1.Bullet.HitboxOffsetY >> 0;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).DirX = xfac;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).DirY = 0;
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).VelX = $imul(v$1.Speed, xfac);
					((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).VelY = 0;
					bulletLocalId = bulletLocalId + (1) >> 0;
					fireballBulletCnt = fireballBulletCnt + (1) >> 0;
					if (!((-1 === v$1.Bullet.SelfLockVelX))) {
						hasLockVel = true;
						thatPlayerInNextFrame.VelX = $imul(xfac, v$1.Bullet.SelfLockVelX);
					}
					if (!((-1 === v$1.Bullet.SelfLockVelY))) {
						hasLockVel = true;
						thatPlayerInNextFrame.VelY = v$1.Bullet.SelfLockVelY;
					}
				}
				if (false === hasLockVel && false === currPlayerDownsync$1.InAir) {
					thatPlayerInNextFrame.VelX = 0;
				}
				thatPlayerInNextFrame.CharacterState = skillConfig.BoundChState;
				_i$1++;
				/* continue; */ $s = 1; continue;
			}
			if (0 === currPlayerDownsync$1.FramesToRecover) {
				prevCapturedByInertia = currPlayerDownsync$1.CapturedByInertia;
				isWallJumping = chConfig.OnWallEnabled && (chConfig.WallJumpingInitVelX === intAbs(currPlayerDownsync$1.VelX));
				alignedWithInertia = true;
				exactTurningAround = false;
				stoppingFromWalking = false;
				if (!((0 === effDx)) && (0 === thatPlayerInNextFrame.VelX)) {
					alignedWithInertia = false;
				} else if ((0 === effDx) && !((0 === thatPlayerInNextFrame.VelX))) {
					alignedWithInertia = false;
					stoppingFromWalking = true;
				} else if (0 > ($imul(effDx, thatPlayerInNextFrame.VelX))) {
					alignedWithInertia = false;
					exactTurningAround = true;
				}
				if (!jumpedOrNot && !isWallJumping && !prevCapturedByInertia && !alignedWithInertia) {
					thatPlayerInNextFrame.CapturedByInertia = true;
					if (exactTurningAround) {
						thatPlayerInNextFrame.CharacterState = 17;
						thatPlayerInNextFrame.FramesToRecover = chConfig.InertiaFramesToRecover;
					} else if (stoppingFromWalking) {
						thatPlayerInNextFrame.FramesToRecover = chConfig.InertiaFramesToRecover;
					} else {
						thatPlayerInNextFrame.FramesToRecover = (((chConfig.InertiaFramesToRecover >> 1 >> 0)) + ((chConfig.InertiaFramesToRecover >> 2 >> 0)) >> 0);
					}
				} else {
					thatPlayerInNextFrame.CapturedByInertia = false;
					if (!((0 === effDx))) {
						xfac$1 = 1;
						if (0 > effDx) {
							xfac$1 = -xfac$1;
						}
						thatPlayerInNextFrame.DirX = effDx;
						thatPlayerInNextFrame.DirY = effDy;
						if (isWallJumping) {
							thatPlayerInNextFrame.VelX = $imul(xfac$1, intAbs(currPlayerDownsync$1.VelX));
						} else {
							thatPlayerInNextFrame.VelX = $imul(xfac$1, currPlayerDownsync$1.Speed);
						}
						thatPlayerInNextFrame.CharacterState = 1;
					} else {
						thatPlayerInNextFrame.CharacterState = 0;
						thatPlayerInNextFrame.VelX = 0;
					}
				}
			}
			_i$1++;
		$s = 1; continue;
		case 2:
		colliderCnt = 0;
		_ref$3 = currRenderFrame.PlayersArr;
		_i$2 = 0;
		/* while (true) { */ case 4:
			/* if (!(_i$2 < _ref$3.$length)) { break; } */ if(!(_i$2 < _ref$3.$length)) { $s = 5; continue; }
			i$2 = _i$2;
			currPlayerDownsync$2 = ((_i$2 < 0 || _i$2 >= _ref$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$3.$array[_ref$3.$offset + _i$2]);
			joinIndex$1 = currPlayerDownsync$2.JoinIndex;
			_tmp = 0;
			_tmp$1 = 0;
			(x$2 = joinIndex$1 - 1 >> 0, ((x$2 < 0 || x$2 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + x$2])).X = _tmp;
			(x$3 = joinIndex$1 - 1 >> 0, ((x$3 < 0 || x$3 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + x$3])).Y = _tmp$1;
			thatPlayerInNextFrame$1 = ((i$2 < 0 || i$2 >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i$2]);
			chConfig$1 = ((i$2 < 0 || i$2 >= chConfigsOrderedByJoinIndex.$length) ? ($throwRuntimeError("index out of range"), undefined) : chConfigsOrderedByJoinIndex.$array[chConfigsOrderedByJoinIndex.$offset + i$2]);
			_tmp$2 = currPlayerDownsync$2.VirtualGridX + currPlayerDownsync$2.VelX >> 0;
			_tmp$3 = currPlayerDownsync$2.VirtualGridY + currPlayerDownsync$2.VelY >> 0;
			newVx = _tmp$2;
			newVy = _tmp$3;
			if (0 >= thatPlayerInNextFrame$1.Hp && (0 === thatPlayerInNextFrame$1.FramesToRecover)) {
				_tmp$4 = currPlayerDownsync$2.RevivalVirtualGridX;
				_tmp$5 = currPlayerDownsync$2.RevivalVirtualGridY;
				newVx = _tmp$4;
				newVy = _tmp$5;
				thatPlayerInNextFrame$1.CharacterState = 10;
				thatPlayerInNextFrame$1.FramesInChState = 10;
				thatPlayerInNextFrame$1.FramesToRecover = chConfig$1.GetUpFramesToRecover;
				thatPlayerInNextFrame$1.FramesInvinsible = chConfig$1.GetUpInvinsibleFrames;
				thatPlayerInNextFrame$1.Hp = currPlayerDownsync$2.MaxHp;
				if (0 === ((_r$1 = thatPlayerInNextFrame$1.JoinIndex % 2, _r$1 === _r$1 ? _r$1 : $throwRuntimeError("integer divide by zero")))) {
					thatPlayerInNextFrame$1.DirX = -2;
					thatPlayerInNextFrame$1.DirY = 0;
				} else {
					thatPlayerInNextFrame$1.DirX = 2;
					thatPlayerInNextFrame$1.DirY = 0;
				}
			}
			if (((i$2 < 0 || i$2 >= jumpedOrNotList.$length) ? ($throwRuntimeError("index out of range"), undefined) : jumpedOrNotList.$array[jumpedOrNotList.$offset + i$2])) {
				if (16 === currPlayerDownsync$2.CharacterState) {
					if (0 < ($imul(currPlayerDownsync$2.VelX, currPlayerDownsync$2.OnWallNormX))) {
						newVx = newVx - (currPlayerDownsync$2.VelX) >> 0;
					}
					xfac$2 = -1;
					if (0 > currPlayerDownsync$2.OnWallNormX) {
						xfac$2 = -xfac$2;
					}
					newVx = newVx + (($imul(xfac$2, chConfig$1.WallJumpingInitVelX))) >> 0;
					newVy = newVy + (chConfig$1.WallJumpingInitVelY) >> 0;
					thatPlayerInNextFrame$1.VelX = (($imul(xfac$2, chConfig$1.WallJumpingInitVelX)));
					thatPlayerInNextFrame$1.VelY = (chConfig$1.WallJumpingInitVelY);
					thatPlayerInNextFrame$1.FramesToRecover = chConfig$1.WallJumpingFramesToRecover;
				} else {
					thatPlayerInNextFrame$1.VelY = (chConfig$1.JumpingInitVelY);
					newVy = newVy + (chConfig$1.JumpingInitVelY) >> 0;
				}
			}
			_tuple$2 = VirtualGridToWorldPos(newVx, newVy);
			wx = _tuple$2[0];
			wy = _tuple$2[1];
			_tmp$6 = $imul(currPlayerDownsync$2.ColliderRadius, 2);
			_tmp$7 = $imul(currPlayerDownsync$2.ColliderRadius, 4);
			colliderWidth = _tmp$6;
			colliderHeight = _tmp$7;
			_1 = currPlayerDownsync$2.CharacterState;
			if (_1 === (9)) {
				_tmp$8 = $imul(currPlayerDownsync$2.ColliderRadius, 4);
				_tmp$9 = $imul(currPlayerDownsync$2.ColliderRadius, 2);
				colliderWidth = _tmp$8;
				colliderHeight = _tmp$9;
			} else if ((_1 === (8)) || (_1 === (4)) || (_1 === (5)) || (_1 === (16))) {
				_tmp$10 = $imul(currPlayerDownsync$2.ColliderRadius, 2);
				_tmp$11 = $imul(currPlayerDownsync$2.ColliderRadius, 2);
				colliderWidth = _tmp$10;
				colliderHeight = _tmp$11;
			}
			_tuple$3 = VirtualGridToWorldPos(colliderWidth, colliderHeight);
			colliderWorldWidth = _tuple$3[0];
			colliderWorldHeight = _tuple$3[1];
			playerCollider = ((colliderCnt < 0 || colliderCnt >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + colliderCnt]);
			UpdateRectCollider(playerCollider, wx, wy, colliderWorldWidth, colliderWorldHeight, 0.1, 0.1, 0.1, 0.1, collisionSpaceOffsetX, collisionSpaceOffsetY, currPlayerDownsync$2, "Player");
			colliderCnt = colliderCnt + (1) >> 0;
			$r = collisionSys.AddSingle(playerCollider); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			if (currPlayerDownsync$2.InAir) {
				if ((16 === currPlayerDownsync$2.CharacterState) && !((i$2 < 0 || i$2 >= jumpedOrNotList.$length) ? ($throwRuntimeError("index out of range"), undefined) : jumpedOrNotList.$array[jumpedOrNotList.$offset + i$2])) {
					thatPlayerInNextFrame$1.VelX = thatPlayerInNextFrame$1.VelX + (0) >> 0;
					thatPlayerInNextFrame$1.VelY = chConfig$1.WallSlidingVelY;
				} else if (15 === currPlayerDownsync$2.CharacterState) {
					thatPlayerInNextFrame$1.VelX = thatPlayerInNextFrame$1.VelX + (0) >> 0;
				} else {
					thatPlayerInNextFrame$1.VelX = thatPlayerInNextFrame$1.VelX + (0) >> 0;
					thatPlayerInNextFrame$1.VelY = thatPlayerInNextFrame$1.VelY + (-5) >> 0;
				}
			}
			_i$2++;
		$s = 4; continue;
		case 5:
		_ref$4 = currRenderFrame.FireballBullets;
		_i$3 = 0;
		/* while (true) { */ case 7:
			/* if (!(_i$3 < _ref$4.$length)) { break; } */ if(!(_i$3 < _ref$4.$length)) { $s = 8; continue; }
			prevFireball = ((_i$3 < 0 || _i$3 >= _ref$4.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$4.$array[_ref$4.$offset + _i$3]);
			if (-1 === prevFireball.BattleAttr.BulletLocalId) {
				/* break; */ $s = 8; continue;
			}
			fireballBullet = ((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]);
			fireballBullet.VirtualGridX = prevFireball.VirtualGridX;
			fireballBullet.VirtualGridY = prevFireball.VirtualGridY;
			fireballBullet.DirX = prevFireball.DirX;
			fireballBullet.DirY = prevFireball.DirY;
			fireballBullet.VelX = prevFireball.VelX;
			fireballBullet.VelY = prevFireball.VelY;
			fireballBullet.Speed = prevFireball.Speed;
			fireballBullet.Bullet = prevFireball.Bullet;
			fireballBullet.BattleAttr = prevFireball.BattleAttr;
			fireballBullet.FramesInBlState = prevFireball.FramesInBlState + 1 >> 0;
			fireballBullet.BlState = prevFireball.BlState;
			/* */ if (IsFireballBulletAlive(fireballBullet, currRenderFrame)) { $s = 9; continue; }
			/* */ $s = 10; continue;
			/* if (IsFireballBulletAlive(fireballBullet, currRenderFrame)) { */ case 9:
				/* */ if (IsFireballBulletActive(fireballBullet, currRenderFrame)) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (IsFireballBulletActive(fireballBullet, currRenderFrame)) { */ case 11:
					_tuple$4 = VirtualGridToWorldPos(fireballBullet.VirtualGridX, fireballBullet.VirtualGridY);
					bulletWx = _tuple$4[0];
					bulletWy = _tuple$4[1];
					_tuple$5 = VirtualGridToWorldPos(fireballBullet.Bullet.HitboxSizeX, fireballBullet.Bullet.HitboxSizeY);
					hitboxSizeWx = _tuple$5[0];
					hitboxSizeWy = _tuple$5[1];
					newBulletCollider = ((colliderCnt < 0 || colliderCnt >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + colliderCnt]);
					UpdateRectCollider(newBulletCollider, bulletWx, bulletWy, hitboxSizeWx, hitboxSizeWy, 0.1, 0.1, 0.1, 0.1, collisionSpaceOffsetX, collisionSpaceOffsetY, fireballBullet, "FireballBullet");
					colliderCnt = colliderCnt + (1) >> 0;
					$r = collisionSys.AddSingle(newBulletCollider); /* */ $s = 14; case 14: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					fireballBullet.BlState = 1;
					if (!((fireballBullet.BlState === prevFireball.BlState))) {
						fireballBullet.FramesInBlState = 0;
					}
					_tmp$12 = fireballBullet.VirtualGridX + fireballBullet.VelX >> 0;
					_tmp$13 = fireballBullet.VirtualGridY + fireballBullet.VelY >> 0;
					fireballBullet.VirtualGridX = _tmp$12;
					fireballBullet.VirtualGridY = _tmp$13;
					$s = 13; continue;
				/* } else { */ case 12:
					offender = (x$4 = currRenderFrame.PlayersArr, x$5 = fireballBullet.BattleAttr.OffenderJoinIndex - 1 >> 0, ((x$5 < 0 || x$5 >= x$4.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$4.$array[x$4.$offset + x$5]));
					_tuple$6 = (_entry$1 = noOpSet[$Int32.keyFor(offender.CharacterState)], _entry$1 !== undefined ? [_entry$1.v, true] : [false, false]);
					existent$1 = _tuple$6[1];
					if (existent$1) {
						_i$3++;
						/* continue; */ $s = 7; continue;
					}
				/* } */ case 13:
				fireballBulletCnt = fireballBulletCnt + (1) >> 0;
			/* } */ case 10:
			_i$3++;
		$s = 7; continue;
		case 8:
		((fireballBulletCnt < 0 || fireballBulletCnt >= nextRenderFrameFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameFireballBullets.$array[nextRenderFrameFireballBullets.$offset + fireballBulletCnt]).BattleAttr.BulletLocalId = -1;
		_ref$5 = currRenderFrame.MeleeBullets;
		_i$4 = 0;
		/* while (true) { */ case 15:
			/* if (!(_i$4 < _ref$5.$length)) { break; } */ if(!(_i$4 < _ref$5.$length)) { $s = 16; continue; }
			prevMelee = ((_i$4 < 0 || _i$4 >= _ref$5.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$5.$array[_ref$5.$offset + _i$4]);
			if (-1 === prevMelee.BattleAttr.BulletLocalId) {
				/* break; */ $s = 16; continue;
			}
			meleeBullet = ((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]);
			meleeBullet.Bullet = prevMelee.Bullet;
			meleeBullet.BattleAttr = prevMelee.BattleAttr;
			meleeBullet.FramesInBlState = prevMelee.FramesInBlState + 1 >> 0;
			meleeBullet.BlState = prevMelee.BlState;
			/* */ if (IsMeleeBulletAlive(meleeBullet, currRenderFrame)) { $s = 17; continue; }
			/* */ $s = 18; continue;
			/* if (IsMeleeBulletAlive(meleeBullet, currRenderFrame)) { */ case 17:
				offender$1 = (x$6 = currRenderFrame.PlayersArr, x$7 = meleeBullet.BattleAttr.OffenderJoinIndex - 1 >> 0, ((x$7 < 0 || x$7 >= x$6.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$6.$array[x$6.$offset + x$7]));
				_tuple$7 = (_entry$2 = noOpSet[$Int32.keyFor(offender$1.CharacterState)], _entry$2 !== undefined ? [_entry$2.v, true] : [false, false]);
				existent$2 = _tuple$7[1];
				if (existent$2) {
					_i$4++;
					/* continue; */ $s = 15; continue;
				}
				/* */ if (IsMeleeBulletActive(meleeBullet, currRenderFrame)) { $s = 19; continue; }
				/* */ $s = 20; continue;
				/* if (IsMeleeBulletActive(meleeBullet, currRenderFrame)) { */ case 19:
					xfac$3 = 1;
					if (0 > offender$1.DirX) {
						xfac$3 = -xfac$3;
					}
					_tuple$8 = VirtualGridToWorldPos(offender$1.VirtualGridX + ($imul(xfac$3, meleeBullet.Bullet.HitboxOffsetX)) >> 0, offender$1.VirtualGridY);
					bulletWx$1 = _tuple$8[0];
					bulletWy$1 = _tuple$8[1];
					_tuple$9 = VirtualGridToWorldPos(meleeBullet.Bullet.HitboxSizeX, meleeBullet.Bullet.HitboxSizeY);
					hitboxSizeWx$1 = _tuple$9[0];
					hitboxSizeWy$1 = _tuple$9[1];
					newBulletCollider$1 = ((colliderCnt < 0 || colliderCnt >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + colliderCnt]);
					UpdateRectCollider(newBulletCollider$1, bulletWx$1, bulletWy$1, hitboxSizeWx$1, hitboxSizeWy$1, 0.1, 0.1, 0.1, 0.1, collisionSpaceOffsetX, collisionSpaceOffsetY, meleeBullet, "MeleeBullet");
					colliderCnt = colliderCnt + (1) >> 0;
					$r = collisionSys.AddSingle(newBulletCollider$1); /* */ $s = 21; case 21: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					meleeBullet.BlState = 1;
					if (!((meleeBullet.BlState === prevMelee.BlState))) {
						meleeBullet.FramesInBlState = 0;
					}
				/* } */ case 20:
				meleeBulletCnt = meleeBulletCnt + (1) >> 0;
			/* } */ case 18:
			_i$4++;
		$s = 15; continue;
		case 16:
		((meleeBulletCnt < 0 || meleeBulletCnt >= nextRenderFrameMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFrameMeleeBullets.$array[nextRenderFrameMeleeBullets.$offset + meleeBulletCnt]).BattleAttr.BulletLocalId = -1;
		_ref$6 = currRenderFrame.PlayersArr;
		_i$5 = 0;
		/* while (true) { */ case 22:
			/* if (!(_i$5 < _ref$6.$length)) { break; } */ if(!(_i$5 < _ref$6.$length)) { $s = 23; continue; }
			i$3 = _i$5;
			currPlayerDownsync$3 = ((_i$5 < 0 || _i$5 >= _ref$6.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$6.$array[_ref$6.$offset + _i$5]);
			joinIndex$2 = currPlayerDownsync$3.JoinIndex;
			playerCollider$1 = ((i$3 < 0 || i$3 >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + i$3]);
			playerShape = $assertType(playerCollider$1.Shape, ptrType$8);
			thatPlayerInNextFrame$2 = ((i$3 < 0 || i$3 >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i$3]);
			_r$2 = calcHardPushbacksNorms(joinIndex$2, currPlayerDownsync$3, thatPlayerInNextFrame$2, playerCollider$1, playerShape, 0.1, (x$8 = joinIndex$2 - 1 >> 0, ((x$8 < 0 || x$8 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + x$8])), (x$9 = joinIndex$2 - 1 >> 0, ((x$9 < 0 || x$9 >= hardPushbackNormsArr.$length) ? ($throwRuntimeError("index out of range"), undefined) : hardPushbackNormsArr.$array[hardPushbackNormsArr.$offset + x$9])), collision); /* */ $s = 24; case 24: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			hardPushbackCnt = _r$2;
			chConfig$2 = ((i$3 < 0 || i$3 >= chConfigsOrderedByJoinIndex.$length) ? ($throwRuntimeError("index out of range"), undefined) : chConfigsOrderedByJoinIndex.$array[chConfigsOrderedByJoinIndex.$offset + i$3]);
			landedOnGravityPushback = false;
			collided = playerCollider$1.CheckAllWithHolder(0, 0, collision);
			/* */ if (collided) { $s = 25; continue; }
			/* */ $s = 26; continue;
			/* if (collided) { */ case 25:
				/* while (true) { */ case 27:
					obj = collision.PopFirstCollidedObject();
					if (ptrType$5.nil === obj) {
						/* break; */ $s = 28; continue;
					}
					_tmp$14 = false;
					_tmp$15 = false;
					_tmp$16 = false;
					isBarrier = _tmp$14;
					isAnotherPlayer = _tmp$15;
					isBullet = _tmp$16;
					_ref$7 = obj.Data;
					if ($assertType(_ref$7, ptrType$6, true)[1]) {
						v$2 = _ref$7.$val;
						if (18 === v$2.CharacterState) {
							/* continue; */ $s = 27; continue;
						}
						isAnotherPlayer = true;
					} else if ($assertType(_ref$7, ptrType$3, true)[1] || $assertType(_ref$7, ptrType$7, true)[1]) {
						v$3 = _ref$7;
						isBullet = true;
					} else {
						v$4 = _ref$7;
						isBarrier = true;
					}
					if (isBullet) {
						/* continue; */ $s = 27; continue;
					}
					bShape = $assertType(obj.Shape, ptrType$8);
					_r$3 = calcPushbacks(0, 0, playerShape, bShape); /* */ $s = 29; case 29: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					_tuple$10 = _r$3;
					overlapped = _tuple$10[0];
					pushbackX = _tuple$10[1];
					pushbackY = _tuple$10[2];
					overlapResult = _tuple$10[3];
					if (!overlapped) {
						/* continue; */ $s = 27; continue;
					}
					normAlignmentWithGravity = overlapResult.OverlapX * 0 + overlapResult.OverlapY * -1;
					if (isAnotherPlayer) {
						_tmp$17 = (overlapResult.Overlap - 0.2) * overlapResult.OverlapX;
						_tmp$18 = (overlapResult.Overlap - 0.2) * overlapResult.OverlapY;
						pushbackX = _tmp$17;
						pushbackY = _tmp$18;
					}
					i$4 = 0;
					while (true) {
						if (!(i$4 < hardPushbackCnt)) { break; }
						hardPushbackNorm = (x$10 = (x$11 = joinIndex$2 - 1 >> 0, ((x$11 < 0 || x$11 >= hardPushbackNormsArr.$length) ? ($throwRuntimeError("index out of range"), undefined) : hardPushbackNormsArr.$array[hardPushbackNormsArr.$offset + x$11])), ((i$4 < 0 || i$4 >= x$10.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$10.$array[x$10.$offset + i$4]));
						projectedMagnitude = pushbackX * hardPushbackNorm.X + pushbackY * hardPushbackNorm.Y;
						if (isBarrier || (isAnotherPlayer && 0 > projectedMagnitude)) {
							pushbackX = pushbackX - (projectedMagnitude * hardPushbackNorm.X);
							pushbackY = pushbackY - (projectedMagnitude * hardPushbackNorm.Y);
						}
						i$4 = i$4 + (1) >> 0;
					}
					_index = joinIndex$2 - 1 >> 0;
					((_index < 0 || _index >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + _index]).X = ((_index < 0 || _index >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + _index]).X + (pushbackX);
					_index$1 = joinIndex$2 - 1 >> 0;
					((_index$1 < 0 || _index$1 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + _index$1]).Y = ((_index$1 < 0 || _index$1 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + _index$1]).Y + (pushbackY);
					if (0.5 < normAlignmentWithGravity) {
						landedOnGravityPushback = true;
					}
				$s = 27; continue;
				case 28:
			/* } */ case 26:
			if (landedOnGravityPushback) {
				thatPlayerInNextFrame$2.InAir = false;
				fallStopping = currPlayerDownsync$3.InAir && 0 >= currPlayerDownsync$3.VelY;
				if (fallStopping) {
					thatPlayerInNextFrame$2.VelY = 0;
					thatPlayerInNextFrame$2.VelX = 0;
					if (18 === thatPlayerInNextFrame$2.CharacterState) {
					} else if (8 === thatPlayerInNextFrame$2.CharacterState) {
						thatPlayerInNextFrame$2.CharacterState = 9;
						thatPlayerInNextFrame$2.FramesToRecover = chConfig$2.LayDownFramesToRecover;
					} else {
						_2 = currPlayerDownsync$3.CharacterState;
						if ((_2 === (8)) || (_2 === (4)) || (_2 === (5)) || (_2 === (16))) {
							_tmp$19 = 0;
							_tmp$20 = currPlayerDownsync$3.ColliderRadius;
							halfColliderWidthDiff = _tmp$19;
							halfColliderHeightDiff = _tmp$20;
							_tuple$11 = VirtualGridToWorldPos(halfColliderWidthDiff, halfColliderHeightDiff);
							halfColliderWorldHeightDiff = _tuple$11[1];
							_index$2 = joinIndex$2 - 1 >> 0;
							((_index$2 < 0 || _index$2 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + _index$2]).Y = ((_index$2 < 0 || _index$2 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + _index$2]).Y - (halfColliderWorldHeightDiff);
						}
						thatPlayerInNextFrame$2.CharacterState = 0;
						thatPlayerInNextFrame$2.FramesToRecover = 0;
					}
				} else {
					_tuple$12 = (_entry$3 = nonAttackingSet[$Int32.keyFor(thatPlayerInNextFrame$2.CharacterState)], _entry$3 !== undefined ? [_entry$3.v, true] : [false, false]);
					existent$3 = _tuple$12[1];
					if (existent$3) {
						if (18 === thatPlayerInNextFrame$2.CharacterState) {
						} else if (9 === thatPlayerInNextFrame$2.CharacterState) {
							if (0 === thatPlayerInNextFrame$2.FramesToRecover) {
								thatPlayerInNextFrame$2.CharacterState = 10;
								thatPlayerInNextFrame$2.FramesToRecover = chConfig$2.GetUpFramesToRecover;
							}
						} else if (10 === thatPlayerInNextFrame$2.CharacterState) {
							if (0 === thatPlayerInNextFrame$2.FramesToRecover) {
								thatPlayerInNextFrame$2.CharacterState = 0;
								thatPlayerInNextFrame$2.FramesInvinsible = chConfig$2.GetUpInvinsibleFrames;
							}
						}
					}
				}
			}
			if (chConfig$2.OnWallEnabled) {
				if (thatPlayerInNextFrame$2.InAir) {
					_tuple$13 = (_entry$4 = noOpSet[$Int32.keyFor(currPlayerDownsync$3.CharacterState)], _entry$4 !== undefined ? [_entry$4.v, true] : [false, false]);
					existent$4 = _tuple$13[1];
					if (!existent$4) {
						i$5 = 0;
						while (true) {
							if (!(i$5 < hardPushbackCnt)) { break; }
							hardPushbackNorm$1 = (x$12 = (x$13 = joinIndex$2 - 1 >> 0, ((x$13 < 0 || x$13 >= hardPushbackNormsArr.$length) ? ($throwRuntimeError("index out of range"), undefined) : hardPushbackNormsArr.$array[hardPushbackNormsArr.$offset + x$13])), ((i$5 < 0 || i$5 >= x$12.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$12.$array[x$12.$offset + i$5]));
							normAlignmentWithHorizon1 = hardPushbackNorm$1.X * 1 + hardPushbackNorm$1.Y * 0;
							normAlignmentWithHorizon2 = hardPushbackNorm$1.X * -1 + hardPushbackNorm$1.Y * 0;
							if (0.9 < normAlignmentWithHorizon1) {
								thatPlayerInNextFrame$2.OnWall = true;
								_tmp$21 = ((hardPushbackNorm$1.X >> 0));
								_tmp$22 = ((hardPushbackNorm$1.Y >> 0));
								thatPlayerInNextFrame$2.OnWallNormX = _tmp$21;
								thatPlayerInNextFrame$2.OnWallNormY = _tmp$22;
								break;
							}
							if (0.9 < normAlignmentWithHorizon2) {
								thatPlayerInNextFrame$2.OnWall = true;
								_tmp$23 = ((hardPushbackNorm$1.X >> 0));
								_tmp$24 = ((hardPushbackNorm$1.Y >> 0));
								thatPlayerInNextFrame$2.OnWallNormX = _tmp$23;
								thatPlayerInNextFrame$2.OnWallNormY = _tmp$24;
								break;
							}
							i$5 = i$5 + (1) >> 0;
						}
					}
				}
				if (!thatPlayerInNextFrame$2.OnWall) {
					_tmp$25 = 0;
					_tmp$26 = 0;
					thatPlayerInNextFrame$2.OnWallNormX = _tmp$25;
					thatPlayerInNextFrame$2.OnWallNormY = _tmp$26;
				}
			}
			_i$5++;
		$s = 22; continue;
		case 23:
		i$6 = nextRenderFramePlayers.$length;
		/* while (true) { */ case 30:
			/* if (!(i$6 < colliderCnt)) { break; } */ if(!(i$6 < colliderCnt)) { $s = 31; continue; }
			bulletCollider = ((i$6 < 0 || i$6 >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + i$6]);
			collided$1 = bulletCollider.CheckAllWithHolder(0, 0, collision);
			if (!collided$1) {
				i$6 = i$6 + (1) >> 0;
				/* continue; */ $s = 30; continue;
			}
			exploded = false;
			explodedOnAnotherPlayer = false;
			bulletStaticAttr = ptrType$1.nil;
			bulletBattleAttr = ptrType.nil;
			_ref$8 = bulletCollider.Data;
			if ($assertType(_ref$8, ptrType$3, true)[1]) {
				v$5 = _ref$8.$val;
				bulletStaticAttr = v$5.Bullet;
				bulletBattleAttr = v$5.BattleAttr;
			} else if ($assertType(_ref$8, ptrType$7, true)[1]) {
				v$6 = _ref$8.$val;
				bulletStaticAttr = v$6.Bullet;
				bulletBattleAttr = v$6.BattleAttr;
			}
			bulletShape = $assertType(bulletCollider.Shape, ptrType$8);
			offender$2 = (x$14 = currRenderFrame.PlayersArr, x$15 = bulletBattleAttr.OffenderJoinIndex - 1 >> 0, ((x$15 < 0 || x$15 >= x$14.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$14.$array[x$14.$offset + x$15]));
			/* while (true) { */ case 32:
				obj$1 = collision.PopFirstCollidedObject();
				if (ptrType$5.nil === obj$1) {
					/* break; */ $s = 33; continue;
				}
				defenderShape = $assertType(obj$1.Shape, ptrType$8);
				_ref$9 = obj$1.Data;
				/* */ if ($assertType(_ref$9, ptrType$6, true)[1]) { $s = 34; continue; }
				/* */ $s = 35; continue;
				/* if ($assertType(_ref$9, ptrType$6, true)[1]) { */ case 34:
					t = _ref$9.$val;
					if (bulletBattleAttr.OffenderJoinIndex === t.JoinIndex) {
						/* continue; */ $s = 32; continue;
					}
					_r$4 = calcPushbacks(0, 0, bulletShape, defenderShape); /* */ $s = 37; case 37: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					_tuple$14 = _r$4;
					overlapped$1 = _tuple$14[0];
					if (!overlapped$1) {
						/* continue; */ $s = 32; continue;
					}
					_tuple$15 = (_entry$5 = invinsibleSet[$Int32.keyFor(t.CharacterState)], _entry$5 !== undefined ? [_entry$5.v, true] : [false, false]);
					existent$5 = _tuple$15[1];
					if (existent$5) {
						/* continue; */ $s = 32; continue;
					}
					if (0 < t.FramesInvinsible) {
						/* continue; */ $s = 32; continue;
					}
					exploded = true;
					explodedOnAnotherPlayer = true;
					xfac$4 = 1;
					if (0 > offender$2.DirX) {
						xfac$4 = -xfac$4;
					}
					atkedPlayerInNextFrame = (x$16 = t.JoinIndex - 1 >> 0, ((x$16 < 0 || x$16 >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + x$16]));
					atkedPlayerInNextFrame.Hp = atkedPlayerInNextFrame.Hp - (bulletStaticAttr.Damage) >> 0;
					if (0 >= atkedPlayerInNextFrame.Hp) {
						atkedPlayerInNextFrame.Hp = 0;
						atkedPlayerInNextFrame.CharacterState = 18;
						atkedPlayerInNextFrame.FramesToRecover = 60;
					} else {
						_tmp$27 = $imul(xfac$4, bulletStaticAttr.PushbackVelX);
						_tmp$28 = bulletStaticAttr.PushbackVelY;
						pushbackVelX = _tmp$27;
						pushbackVelY = _tmp$28;
						atkedPlayerInNextFrame.VelX = pushbackVelX;
						atkedPlayerInNextFrame.VelY = pushbackVelY;
						if (bulletStaticAttr.BlowUp) {
							atkedPlayerInNextFrame.CharacterState = 8;
						} else {
							atkedPlayerInNextFrame.CharacterState = 3;
						}
						oldFramesToRecover = (x$17 = t.JoinIndex - 1 >> 0, ((x$17 < 0 || x$17 >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + x$17])).FramesToRecover;
						if (bulletStaticAttr.HitStunFrames > oldFramesToRecover) {
							atkedPlayerInNextFrame.FramesToRecover = bulletStaticAttr.HitStunFrames;
						}
					}
					$s = 36; continue;
				/* } else { */ case 35:
					t$1 = _ref$9;
					exploded = true;
				/* } */ case 36:
			$s = 32; continue;
			case 33:
			if (exploded) {
				_ref$10 = bulletCollider.Data;
				if ($assertType(_ref$10, ptrType$3, true)[1]) {
					v$7 = _ref$10.$val;
					v$7.BlState = 2;
					if (explodedOnAnotherPlayer) {
						v$7.FramesInBlState = 0;
					} else {
						v$7.FramesInBlState = v$7.Bullet.ExplosionFrames + 1 >> 0;
					}
				} else if ($assertType(_ref$10, ptrType$7, true)[1]) {
					v$8 = _ref$10.$val;
					v$8.BlState = 2;
					v$8.FramesInBlState = 0;
				}
			}
			i$6 = i$6 + (1) >> 0;
		$s = 30; continue;
		case 31:
		_ref$11 = currRenderFrame.PlayersArr;
		_i$6 = 0;
		while (true) {
			if (!(_i$6 < _ref$11.$length)) { break; }
			i$7 = _i$6;
			currPlayerDownsync$4 = ((_i$6 < 0 || _i$6 >= _ref$11.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$11.$array[_ref$11.$offset + _i$6]);
			joinIndex$3 = currPlayerDownsync$4.JoinIndex;
			playerCollider$2 = ((i$7 < 0 || i$7 >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + i$7]);
			thatPlayerInNextFrame$3 = ((i$7 < 0 || i$7 >= nextRenderFramePlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : nextRenderFramePlayers.$array[nextRenderFramePlayers.$offset + i$7]);
			_tuple$16 = PolygonColliderBLToVirtualGridPos(playerCollider$2.X - (x$18 = joinIndex$3 - 1 >> 0, ((x$18 < 0 || x$18 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + x$18])).X, playerCollider$2.Y - (x$19 = joinIndex$3 - 1 >> 0, ((x$19 < 0 || x$19 >= effPushbacks.$length) ? ($throwRuntimeError("index out of range"), undefined) : effPushbacks.$array[effPushbacks.$offset + x$19])).Y, playerCollider$2.W * 0.5, playerCollider$2.H * 0.5, 0, 0, 0, 0, collisionSpaceOffsetX, collisionSpaceOffsetY);
			thatPlayerInNextFrame$3.VirtualGridX = _tuple$16[0];
			thatPlayerInNextFrame$3.VirtualGridY = _tuple$16[1];
			if (thatPlayerInNextFrame$3.InAir) {
				oldNextCharacterState = thatPlayerInNextFrame$3.CharacterState;
				_3 = oldNextCharacterState;
				if ((_3 === (0)) || (_3 === (1)) || (_3 === (17))) {
					if (((i$7 < 0 || i$7 >= jumpedOrNotList.$length) ? ($throwRuntimeError("index out of range"), undefined) : jumpedOrNotList.$array[jumpedOrNotList.$offset + i$7]) || (5 === currPlayerDownsync$4.CharacterState)) {
						thatPlayerInNextFrame$3.CharacterState = 5;
					} else {
						thatPlayerInNextFrame$3.CharacterState = 4;
					}
				} else if (_3 === (2)) {
					thatPlayerInNextFrame$3.CharacterState = 6;
				} else if (_3 === (3)) {
					thatPlayerInNextFrame$3.CharacterState = 7;
				}
			}
			if (thatPlayerInNextFrame$3.OnWall) {
				_4 = thatPlayerInNextFrame$3.CharacterState;
				if ((_4 === (1)) || (_4 === (5)) || (_4 === (4))) {
					hasBeenOnWallChState = (16 === currPlayerDownsync$4.CharacterState);
					hasBeenOnWallCollisionResultForSameChState = currPlayerDownsync$4.OnWall && 12 <= thatPlayerInNextFrame$3.FramesInChState;
					if (hasBeenOnWallChState || hasBeenOnWallCollisionResultForSameChState) {
						thatPlayerInNextFrame$3.CharacterState = 16;
					}
				}
			}
			if (!((thatPlayerInNextFrame$3.CharacterState === currPlayerDownsync$4.CharacterState))) {
				thatPlayerInNextFrame$3.FramesInChState = 0;
			}
			_tuple$17 = (_entry$6 = nonAttackingSet[$Int32.keyFor(thatPlayerInNextFrame$3.CharacterState)], _entry$6 !== undefined ? [_entry$6.v, true] : [false, false]);
			existent$6 = _tuple$17[1];
			if (existent$6) {
				thatPlayerInNextFrame$3.ActiveSkillId = -1;
				thatPlayerInNextFrame$3.ActiveSkillHit = -1;
			}
			_i$6++;
		}
		i$8 = 0;
		while (true) {
			if (!(i$8 < colliderCnt)) { break; }
			dynamicCollider = ((i$8 < 0 || i$8 >= dynamicRectangleColliders.$length) ? ($throwRuntimeError("index out of range"), undefined) : dynamicRectangleColliders.$array[dynamicRectangleColliders.$offset + i$8]);
			dynamicCollider.Space.RemoveSingle(dynamicCollider);
			i$8 = i$8 + (1) >> 0;
		}
		ret.Id = nextRenderFrameId;
		ret.BulletLocalIdCounter = bulletLocalId;
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: ApplyInputFrameDownsyncDynamicsOnSingleRenderFrame, $c: true, $r, _1, _2, _3, _4, _entry, _entry$1, _entry$2, _entry$3, _entry$4, _entry$5, _entry$6, _i, _i$1, _i$2, _i$3, _i$4, _i$5, _i$6, _index, _index$1, _index$2, _r, _r$1, _r$2, _r$3, _r$4, _ref, _ref$1, _ref$10, _ref$11, _ref$2, _ref$3, _ref$4, _ref$5, _ref$6, _ref$7, _ref$8, _ref$9, _tmp, _tmp$1, _tmp$10, _tmp$11, _tmp$12, _tmp$13, _tmp$14, _tmp$15, _tmp$16, _tmp$17, _tmp$18, _tmp$19, _tmp$2, _tmp$20, _tmp$21, _tmp$22, _tmp$23, _tmp$24, _tmp$25, _tmp$26, _tmp$27, _tmp$28, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tmp$9, _tuple, _tuple$1, _tuple$10, _tuple$11, _tuple$12, _tuple$13, _tuple$14, _tuple$15, _tuple$16, _tuple$17, _tuple$2, _tuple$3, _tuple$4, _tuple$5, _tuple$6, _tuple$7, _tuple$8, _tuple$9, alignedWithInertia, atkedPlayerInNextFrame, bShape, bulletBattleAttr, bulletCollider, bulletLocalId, bulletShape, bulletStaticAttr, bulletWx, bulletWx$1, bulletWy, bulletWy$1, candidate, chConfig, chConfig$1, chConfig$2, chConfigsOrderedByJoinIndex, collided, collided$1, colliderCnt, colliderHeight, colliderWidth, colliderWorldHeight, colliderWorldWidth, collision, collisionSpaceOffsetX, collisionSpaceOffsetY, collisionSys, collisionSysMap, currPlayerDownsync, currPlayerDownsync$1, currPlayerDownsync$2, currPlayerDownsync$3, currPlayerDownsync$4, currRenderFrame, currRenderFrameId, defenderShape, dynamicCollider, dynamicRectangleColliders, effDx, effDy, effPushbacks, exactTurningAround, existent, existent$1, existent$2, existent$3, existent$4, existent$5, existent$6, exploded, explodedOnAnotherPlayer, fallStopping, fireballBullet, fireballBulletCnt, halfColliderHeightDiff, halfColliderWidthDiff, halfColliderWorldHeightDiff, hardPushbackCnt, hardPushbackNorm, hardPushbackNorm$1, hardPushbackNormsArr, hasBeenOnWallChState, hasBeenOnWallCollisionResultForSameChState, hasLockVel, hitboxSizeWx, hitboxSizeWx$1, hitboxSizeWy, hitboxSizeWy$1, i, i$1, i$2, i$3, i$4, i$5, i$6, i$7, i$8, inputsBuffer, isAnotherPlayer, isBarrier, isBullet, isWallJumping, joinIndex, joinIndex$1, joinIndex$2, joinIndex$3, jumpedOrNot, jumpedOrNotList, landedOnGravityPushback, meleeBullet, meleeBulletCnt, newBulletCollider, newBulletCollider$1, newVx, newVy, nextRenderFrameFireballBullets, nextRenderFrameId, nextRenderFrameMeleeBullets, nextRenderFramePlayers, normAlignmentWithGravity, normAlignmentWithHorizon1, normAlignmentWithHorizon2, obj, obj$1, offender, offender$1, offender$2, oldFramesToRecover, oldNextCharacterState, overlapResult, overlapped, overlapped$1, patternId, playerCollider, playerCollider$1, playerCollider$2, playerShape, prevCapturedByInertia, prevFireball, prevMelee, projectedMagnitude, pushbackVelX, pushbackVelY, pushbackX, pushbackY, renderFrameBuffer, ret, roomCapacity, skillConfig, skillId, stoppingFromWalking, t, t$1, thatPlayerInNextFrame, thatPlayerInNextFrame$1, thatPlayerInNextFrame$2, thatPlayerInNextFrame$3, v, v$1, v$2, v$3, v$4, v$5, v$6, v$7, v$8, wx, wy, x, x$1, x$10, x$11, x$12, x$13, x$14, x$15, x$16, x$17, x$18, x$19, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, xfac, xfac$1, xfac$2, xfac$3, xfac$4, $s};return $f;
	};
	$pkg.ApplyInputFrameDownsyncDynamicsOnSingleRenderFrame = ApplyInputFrameDownsyncDynamicsOnSingleRenderFrame;
	GenerateRectCollider = function(wx, wy, w, h, topPadding, bottomPadding, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY, data, tag) {
		var {$24r, _r, _tuple, blX, blY, bottomPadding, data, h, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY, tag, topPadding, w, wx, wy, $s, $r, $c} = $restore(this, {wx, wy, w, h, topPadding, bottomPadding, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY, data, tag});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_tuple = WorldToPolygonColliderBLPos(wx, wy, w * 0.5, h * 0.5, topPadding, bottomPadding, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY);
		blX = _tuple[0];
		blY = _tuple[1];
		_r = generateRectColliderInCollisionSpace(blX, blY, leftPadding + w + rightPadding, bottomPadding + h + topPadding, data, tag); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: GenerateRectCollider, $c: true, $r, $24r, _r, _tuple, blX, blY, bottomPadding, data, h, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY, tag, topPadding, w, wx, wy, $s};return $f;
	};
	$pkg.GenerateRectCollider = GenerateRectCollider;
	generateRectColliderInCollisionSpace = function(blX, blY, w, h, data, tag) {
		var {blX, blY, collider, data, h, shape, tag, w, $s, $r, $c} = $restore(this, {blX, blY, w, h, data, tag});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		collider = resolv.NewObjectSingleTag(blX, blY, w, h, tag);
		shape = resolv.NewRectangle(0, 0, w, h);
		$r = collider.SetShape(shape); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		collider.Data = data;
		$s = -1; return collider;
		/* */ } return; } var $f = {$blk: generateRectColliderInCollisionSpace, $c: true, $r, blX, blY, collider, data, h, shape, tag, w, $s};return $f;
	};
	UpdateRectCollider = function(collider, wx, wy, w, h, topPadding, bottomPadding, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY, data, tag) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tuple, blX, blY, bottomPadding, collider, data, effH, effW, h, leftPadding, rectShape, rightPadding, spaceOffsetX, spaceOffsetY, tag, topPadding, w, wx, wy;
		_tuple = WorldToPolygonColliderBLPos(wx, wy, w * 0.5, h * 0.5, topPadding, bottomPadding, leftPadding, rightPadding, spaceOffsetX, spaceOffsetY);
		blX = _tuple[0];
		blY = _tuple[1];
		_tmp = leftPadding + w + rightPadding;
		_tmp$1 = bottomPadding + h + topPadding;
		effW = _tmp;
		effH = _tmp$1;
		_tmp$2 = blX;
		_tmp$3 = blY;
		_tmp$4 = effW;
		_tmp$5 = effH;
		collider.X = _tmp$2;
		collider.Y = _tmp$3;
		collider.W = _tmp$4;
		collider.H = _tmp$5;
		rectShape = $assertType(collider.Shape, ptrType$8);
		rectShape.UpdateAsRectangle(0, 0, effW, effH);
		collider.Data = data;
	};
	$pkg.UpdateRectCollider = UpdateRectCollider;
	GenerateConvexPolygonCollider = function(unalignedSrc, spaceOffsetX, spaceOffsetY, data, tag) {
		var {_i, _i$1, _ref, _ref$1, _tmp, _tmp$1, aligned, collider, data, h, i, i$1, j, p, pi, pj, shape, spaceOffsetX, spaceOffsetY, tag, unalignedSrc, w, x, $s, $r, $c} = $restore(this, {unalignedSrc, spaceOffsetX, spaceOffsetY, data, tag});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		aligned = AlignPolygon2DToBoundingBox(unalignedSrc);
		_tmp = 0;
		_tmp$1 = 0;
		w = _tmp;
		h = _tmp$1;
		shape = resolv.NewConvexPolygon(sliceType$4.nil);
		_ref = aligned.Points;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			pi = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_ref$1 = aligned.Points;
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				j = _i$1;
				pj = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
				if (i === j) {
					_i$1++;
					continue;
				}
				if (math.Abs(pj.X - pi.X) > w) {
					w = math.Abs(pj.X - pi.X);
				}
				if (math.Abs(pj.Y - pi.Y) > h) {
					h = math.Abs(pj.Y - pi.Y);
				}
				_i$1++;
			}
			_i++;
		}
		i$1 = 0;
		while (true) {
			if (!(i$1 < aligned.Points.$length)) { break; }
			p = (x = aligned.Points, ((i$1 < 0 || i$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i$1]));
			shape.AddPoints(new sliceType$4([p.X, p.Y]));
			i$1 = i$1 + (1) >> 0;
		}
		collider = resolv.NewObject(aligned.Anchor.X + spaceOffsetX, aligned.Anchor.Y + spaceOffsetY, w, h, new sliceType$5([tag]));
		$r = collider.SetShape(shape); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		collider.Data = data;
		$s = -1; return collider;
		/* */ } return; } var $f = {$blk: GenerateConvexPolygonCollider, $c: true, $r, _i, _i$1, _ref, _ref$1, _tmp, _tmp$1, aligned, collider, data, h, i, i$1, j, p, pi, pj, shape, spaceOffsetX, spaceOffsetY, tag, unalignedSrc, w, x, $s};return $f;
	};
	$pkg.GenerateConvexPolygonCollider = GenerateConvexPolygonCollider;
	AlignPolygon2DToBoundingBox = function(input) {
		var _i, _i$1, _ref, _ref$1, boundingBoxBL, i, input, output, p, p$1, x;
		boundingBoxBL = new Vec2D.ptr(1.7e+308, 1.7e+308);
		_ref = input.Points;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			p = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (p.X < boundingBoxBL.X) {
				boundingBoxBL.X = p.X;
			}
			if (p.Y < boundingBoxBL.Y) {
				boundingBoxBL.Y = p.Y;
			}
			_i++;
		}
		output = new Polygon2D.ptr(new Vec2D.ptr(input.Anchor.X + boundingBoxBL.X, input.Anchor.Y + boundingBoxBL.Y), $makeSlice(sliceType$6, input.Points.$length));
		_ref$1 = input.Points;
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			i = _i$1;
			p$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			(x = output.Points, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i] = new Vec2D.ptr(p$1.X - boundingBoxBL.X, p$1.Y - boundingBoxBL.Y)));
			_i$1++;
		}
		return output;
	};
	$pkg.AlignPolygon2DToBoundingBox = AlignPolygon2DToBoundingBox;
	NewMeleeBullet = function(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, teamId, blState, framesInBlState, explosionFrames, speciesId) {
		var activeFrames, blState, blockStunFrames, blowUp, bulletLocalId, cancellableEdFrame, cancellableStFrame, damage, explosionFrames, framesInBlState, hitStunFrames, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, offenderJoinIndex, originatedRenderFrameId, pushbackVelX, pushbackVelY, selfLockVelX, selfLockVelY, speciesId, startupFrames, teamId;
		return new MeleeBullet.ptr(blState, framesInBlState, new BulletBattleAttr.ptr(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, teamId), new BulletConfig.ptr(startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, explosionFrames, speciesId, false));
	};
	$pkg.NewMeleeBullet = NewMeleeBullet;
	NewFireballBullet = function(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, teamId, virtualGridX, virtualGridY, dirX, dirY, velX, velY, speed, blState, framesInBlState, explosionFrames, speciesId) {
		var activeFrames, blState, blockStunFrames, blowUp, bulletLocalId, cancellableEdFrame, cancellableStFrame, damage, dirX, dirY, explosionFrames, framesInBlState, hitStunFrames, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, offenderJoinIndex, originatedRenderFrameId, pushbackVelX, pushbackVelY, selfLockVelX, selfLockVelY, speciesId, speed, startupFrames, teamId, velX, velY, virtualGridX, virtualGridY;
		return new FireballBullet.ptr(virtualGridX, virtualGridY, dirX, dirY, velX, velY, speed, blState, framesInBlState, new BulletBattleAttr.ptr(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, teamId), new BulletConfig.ptr(startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, explosionFrames, speciesId, false));
	};
	$pkg.NewFireballBullet = NewFireballBullet;
	NewPlayerDownsync = function(id, virtualGridX, virtualGridY, dirX, dirY, velX, velY, framesToRecover, framesInChState, activeSkillId, activeSkillHit, framesInvinsible, speed, battleState, characterState, joinIndex, hp, maxHp, colliderRadius, inAir, onWall, onWallNormX, onWallNormY, capturedByInertia, bulletTeamId, chCollisionTeamId, revivalVirtualGridX, revivalVirtualGridY) {
		var activeSkillHit, activeSkillId, battleState, bulletTeamId, capturedByInertia, chCollisionTeamId, characterState, colliderRadius, dirX, dirY, framesInChState, framesInvinsible, framesToRecover, hp, id, inAir, joinIndex, maxHp, onWall, onWallNormX, onWallNormY, revivalVirtualGridX, revivalVirtualGridY, speed, velX, velY, virtualGridX, virtualGridY;
		return new PlayerDownsync.ptr(id, virtualGridX, virtualGridY, dirX, dirY, velX, velY, speed, battleState, joinIndex, colliderRadius, false, 0, 0, framesToRecover, framesInChState, hp, maxHp, characterState, inAir, onWall, onWallNormX, onWallNormY, capturedByInertia, activeSkillId, activeSkillHit, framesInvinsible, bulletTeamId, chCollisionTeamId, revivalVirtualGridX, revivalVirtualGridY);
	};
	$pkg.NewPlayerDownsync = NewPlayerDownsync;
	CloneMeleeBullet = function(blState, framesInBlState, dynamicBattleAttr, staticBulletConfig, dst) {
		var blState, dst, dynamicBattleAttr, framesInBlState, staticBulletConfig;
		dst.BlState = blState;
		dst.FramesInBlState = framesInBlState;
		dst.BattleAttr.BulletLocalId = dynamicBattleAttr.BulletLocalId;
		dst.BattleAttr.OriginatedRenderFrameId = dynamicBattleAttr.OriginatedRenderFrameId;
		dst.BattleAttr.OffenderJoinIndex = dynamicBattleAttr.OffenderJoinIndex;
		dst.BattleAttr.TeamId = dynamicBattleAttr.TeamId;
		dst.Bullet = staticBulletConfig;
	};
	$pkg.CloneMeleeBullet = CloneMeleeBullet;
	CloneFireballBullet = function(blState, framesInBlState, virtualGridX, virtualGridY, dirX, dirY, velX, velY, speed, dynamicBattleAttr, staticBulletConfig, dst) {
		var blState, dirX, dirY, dst, dynamicBattleAttr, framesInBlState, speed, staticBulletConfig, velX, velY, virtualGridX, virtualGridY;
		dst.BlState = blState;
		dst.FramesInBlState = framesInBlState;
		dst.VirtualGridX = virtualGridX;
		dst.VirtualGridY = virtualGridY;
		dst.DirX = dirX;
		dst.DirY = dirY;
		dst.VelX = velX;
		dst.VelY = velY;
		dst.Speed = speed;
		dst.BattleAttr.BulletLocalId = dynamicBattleAttr.BulletLocalId;
		dst.BattleAttr.OriginatedRenderFrameId = dynamicBattleAttr.OriginatedRenderFrameId;
		dst.BattleAttr.OffenderJoinIndex = dynamicBattleAttr.OffenderJoinIndex;
		dst.BattleAttr.TeamId = dynamicBattleAttr.TeamId;
		dst.Bullet = staticBulletConfig;
	};
	$pkg.CloneFireballBullet = CloneFireballBullet;
	ClonePlayerDownsync = function(id, virtualGridX, virtualGridY, dirX, dirY, velX, velY, framesToRecover, framesInChState, activeSkillId, activeSkillHit, framesInvinsible, speed, battleState, characterState, joinIndex, hp, maxHp, colliderRadius, inAir, onWall, onWallNormX, onWallNormY, capturedByInertia, bulletTeamId, chCollisionTeamId, revivalVirtualGridX, revivalVirtualGridY, dst) {
		var activeSkillHit, activeSkillId, battleState, bulletTeamId, capturedByInertia, chCollisionTeamId, characterState, colliderRadius, dirX, dirY, dst, framesInChState, framesInvinsible, framesToRecover, hp, id, inAir, joinIndex, maxHp, onWall, onWallNormX, onWallNormY, revivalVirtualGridX, revivalVirtualGridY, speed, velX, velY, virtualGridX, virtualGridY;
		dst.Id = id;
		dst.VirtualGridX = virtualGridX;
		dst.VirtualGridY = virtualGridY;
		dst.DirX = dirX;
		dst.DirY = dirY;
		dst.VelX = velX;
		dst.VelY = velY;
		dst.FramesToRecover = framesToRecover;
		dst.FramesInChState = framesInChState;
		dst.ActiveSkillId = activeSkillId;
		dst.ActiveSkillHit = activeSkillHit;
		dst.FramesInvinsible = framesInvinsible;
		dst.Speed = speed;
		dst.BattleState = battleState;
		dst.CharacterState = characterState;
		dst.JoinIndex = joinIndex;
		dst.Hp = hp;
		dst.MaxHp = maxHp;
		dst.ColliderRadius = colliderRadius;
		dst.InAir = inAir;
		dst.OnWall = onWall;
		dst.OnWallNormX = onWallNormX;
		dst.OnWallNormY = onWallNormY;
		dst.CapturedByInertia = capturedByInertia;
		dst.BulletTeamId = bulletTeamId;
		dst.ChCollisionTeamId = chCollisionTeamId;
		dst.RevivalVirtualGridX = revivalVirtualGridX;
		dst.RevivalVirtualGridY = revivalVirtualGridY;
	};
	$pkg.ClonePlayerDownsync = ClonePlayerDownsync;
	CloneRoomDownsyncFrame = function(id, playersArr, bulletLocalIdCounter, meleeBullets, fireballBullets, dst) {
		var bulletLocalIdCounter, dst, fireballBullets, i, i$1, i$2, id, meleeBullets, playersArr, src, src$1, src$2, x, x$1, x$2;
		dst.Id = id;
		dst.BulletLocalIdCounter = bulletLocalIdCounter;
		i = 0;
		while (true) {
			if (!(i < playersArr.$length)) { break; }
			src = ((i < 0 || i >= playersArr.$length) ? ($throwRuntimeError("index out of range"), undefined) : playersArr.$array[playersArr.$offset + i]);
			if (ptrType$6.nil === src || (-1 === src.Id)) {
				break;
			}
			ClonePlayerDownsync(src.Id, src.VirtualGridX, src.VirtualGridY, src.DirX, src.DirY, src.VelX, src.VelY, src.FramesToRecover, src.FramesInChState, src.ActiveSkillId, src.ActiveSkillHit, src.FramesInvinsible, src.Speed, src.BattleState, src.CharacterState, src.JoinIndex, src.Hp, src.MaxHp, src.ColliderRadius, src.InAir, src.OnWall, src.OnWallNormX, src.OnWallNormY, src.CapturedByInertia, src.BulletTeamId, src.ChCollisionTeamId, src.RevivalVirtualGridX, src.RevivalVirtualGridY, (x = dst.PlayersArr, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
			i = i + (1) >> 0;
		}
		i$1 = 0;
		while (true) {
			if (!(i$1 < meleeBullets.$length)) { break; }
			src$1 = ((i$1 < 0 || i$1 >= meleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : meleeBullets.$array[meleeBullets.$offset + i$1]);
			if (ptrType$3.nil === src$1 || (-1 === src$1.BattleAttr.BulletLocalId)) {
				break;
			}
			CloneMeleeBullet(src$1.BlState, src$1.FramesInBlState, src$1.BattleAttr, src$1.Bullet, (x$1 = dst.MeleeBullets, ((i$1 < 0 || i$1 >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i$1])));
			i$1 = i$1 + (1) >> 0;
		}
		i$2 = 0;
		while (true) {
			if (!(i$2 < fireballBullets.$length)) { break; }
			src$2 = ((i$2 < 0 || i$2 >= fireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : fireballBullets.$array[fireballBullets.$offset + i$2]);
			if (ptrType$7.nil === src$2 || (-1 === src$2.BattleAttr.BulletLocalId)) {
				break;
			}
			CloneFireballBullet(src$2.BlState, src$2.FramesInBlState, src$2.VirtualGridX, src$2.VirtualGridY, src$2.DirX, src$2.DirY, src$2.VelX, src$2.VelY, src$2.Speed, src$2.BattleAttr, src$2.Bullet, (x$2 = dst.FireballBullets, ((i$2 < 0 || i$2 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i$2])));
			i$2 = i$2 + (1) >> 0;
		}
	};
	$pkg.CloneRoomDownsyncFrame = CloneRoomDownsyncFrame;
	NewPreallocatedRoomDownsyncFrame = function(roomCapacity, preallocMeleeBulletCount, preallocFireballBulletCount) {
		var i, i$1, i$2, preallocFireballBulletCount, preallocMeleeBulletCount, preallocatedFireball, preallocatedFireballBullets, preallocatedMelee, preallocatedMeleeBullets, preallocatedPlayer, preallocatedPlayers, roomCapacity;
		preallocatedPlayers = $makeSlice(sliceType$7, roomCapacity);
		i = 0;
		while (true) {
			if (!(i < roomCapacity)) { break; }
			preallocatedPlayer = NewPlayerDownsync(-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false, 0, 0, false, 0, 0, 0, 0);
			((i < 0 || i >= preallocatedPlayers.$length) ? ($throwRuntimeError("index out of range"), undefined) : preallocatedPlayers.$array[preallocatedPlayers.$offset + i] = preallocatedPlayer);
			i = i + (1) >> 0;
		}
		preallocatedMeleeBullets = $makeSlice(sliceType$8, preallocMeleeBulletCount);
		i$1 = 0;
		while (true) {
			if (!(i$1 < preallocMeleeBulletCount)) { break; }
			preallocatedMelee = NewMeleeBullet(-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, 0, 0, 0, 0);
			((i$1 < 0 || i$1 >= preallocatedMeleeBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : preallocatedMeleeBullets.$array[preallocatedMeleeBullets.$offset + i$1] = preallocatedMelee);
			i$1 = i$1 + (1) >> 0;
		}
		preallocatedFireballBullets = $makeSlice(sliceType$9, preallocFireballBulletCount);
		i$2 = 0;
		while (true) {
			if (!(i$2 < preallocFireballBulletCount)) { break; }
			preallocatedFireball = NewFireballBullet(-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
			((i$2 < 0 || i$2 >= preallocatedFireballBullets.$length) ? ($throwRuntimeError("index out of range"), undefined) : preallocatedFireballBullets.$array[preallocatedFireballBullets.$offset + i$2] = preallocatedFireball);
			i$2 = i$2 + (1) >> 0;
		}
		return new RoomDownsyncFrame.ptr(-1, preallocatedPlayers, new $Int64(0, 0), preallocatedMeleeBullets, preallocatedFireballBullets, new $Uint64(0, 0), false, -1);
	};
	$pkg.NewPreallocatedRoomDownsyncFrame = NewPreallocatedRoomDownsyncFrame;
	ptrType$6.methods = [{prop: "GetId", name: "GetId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetJoinIndex", name: "GetJoinIndex", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVirtualGridX", name: "GetVirtualGridX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVirtualGridY", name: "GetVirtualGridY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetDirX", name: "GetDirX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetDirY", name: "GetDirY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVelX", name: "GetVelX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVelY", name: "GetVelY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetSpeed", name: "GetSpeed", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHp", name: "GetHp", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetMaxHp", name: "GetMaxHp", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetCharacterState", name: "GetCharacterState", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetFramesToRecover", name: "GetFramesToRecover", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetFramesInChState", name: "GetFramesInChState", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetInAir", name: "GetInAir", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "GetOnWall", name: "GetOnWall", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "GetOnWallNormX", name: "GetOnWallNormX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetColliderRadius", name: "GetColliderRadius", pkg: "", typ: $funcType([], [$Int32], false)}];
	ptrType$3.methods = [{prop: "GetBlState", name: "GetBlState", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetFramesInBlState", name: "GetFramesInBlState", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetBulletLocalId", name: "GetBulletLocalId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetOffenderJoinIndex", name: "GetOffenderJoinIndex", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetOriginatedRenderFrameId", name: "GetOriginatedRenderFrameId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetStartupFrames", name: "GetStartupFrames", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetActiveFrames", name: "GetActiveFrames", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxSizeX", name: "GetHitboxSizeX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxSizeY", name: "GetHitboxSizeY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxOffsetX", name: "GetHitboxOffsetX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxOffsetY", name: "GetHitboxOffsetY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetExplosionFrames", name: "GetExplosionFrames", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetSpeciesId", name: "GetSpeciesId", pkg: "", typ: $funcType([], [$Int32], false)}];
	ptrType$7.methods = [{prop: "GetVirtualGridX", name: "GetVirtualGridX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVirtualGridY", name: "GetVirtualGridY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetDirX", name: "GetDirX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetDirY", name: "GetDirY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVelX", name: "GetVelX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetVelY", name: "GetVelY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetSpeed", name: "GetSpeed", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetBlState", name: "GetBlState", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetFramesInBlState", name: "GetFramesInBlState", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetBulletLocalId", name: "GetBulletLocalId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetOffenderJoinIndex", name: "GetOffenderJoinIndex", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetOriginatedRenderFrameId", name: "GetOriginatedRenderFrameId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetStartupFrames", name: "GetStartupFrames", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetActiveFrames", name: "GetActiveFrames", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxSizeX", name: "GetHitboxSizeX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxSizeY", name: "GetHitboxSizeY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxOffsetX", name: "GetHitboxOffsetX", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetHitboxOffsetY", name: "GetHitboxOffsetY", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetExplosionFrames", name: "GetExplosionFrames", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetSpeciesId", name: "GetSpeciesId", pkg: "", typ: $funcType([], [$Int32], false)}];
	ptrType$10.methods = [{prop: "GetId", name: "GetId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetCountdownNanos", name: "GetCountdownNanos", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "GetBackendUnconfirmedMask", name: "GetBackendUnconfirmedMask", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "GetBulletLocalIdCounter", name: "GetBulletLocalIdCounter", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetShouldForceResync", name: "GetShouldForceResync", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "GetPlayersArr", name: "GetPlayersArr", pkg: "", typ: $funcType([], [sliceType$7], false)}, {prop: "GetMeleeBullets", name: "GetMeleeBullets", pkg: "", typ: $funcType([], [sliceType$8], false)}, {prop: "GetFireballBullets", name: "GetFireballBullets", pkg: "", typ: $funcType([], [sliceType$9], false)}];
	ptrType$9.methods = [{prop: "GetInputFrameId", name: "GetInputFrameId", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetInputList", name: "GetInputList", pkg: "", typ: $funcType([], [sliceType$3], false)}, {prop: "GetConfirmedList", name: "GetConfirmedList", pkg: "", typ: $funcType([], [$Uint64], false)}];
	ptrType$13.methods = [{prop: "GetSpeed", name: "GetSpeed", pkg: "", typ: $funcType([], [$Int32], false)}, {prop: "GetSpeciesId", name: "GetSpeciesId", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "GetSpeciesName", name: "GetSpeciesName", pkg: "", typ: $funcType([], [$String], false)}];
	Vec2D.init("", [{prop: "X", name: "X", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Y", name: "Y", embedded: false, exported: true, typ: $Float64, tag: ""}]);
	Polygon2D.init("", [{prop: "Anchor", name: "Anchor", embedded: false, exported: true, typ: ptrType$11, tag: ""}, {prop: "Points", name: "Points", embedded: false, exported: true, typ: sliceType$6, tag: ""}]);
	PlayerDownsync.init("", [{prop: "Id", name: "Id", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VirtualGridX", name: "VirtualGridX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VirtualGridY", name: "VirtualGridY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "DirX", name: "DirX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "DirY", name: "DirY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VelX", name: "VelX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VelY", name: "VelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Speed", name: "Speed", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BattleState", name: "BattleState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "JoinIndex", name: "JoinIndex", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "ColliderRadius", name: "ColliderRadius", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Removed", name: "Removed", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "Score", name: "Score", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "LastMoveGmtMillis", name: "LastMoveGmtMillis", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "FramesToRecover", name: "FramesToRecover", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "FramesInChState", name: "FramesInChState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Hp", name: "Hp", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "MaxHp", name: "MaxHp", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "CharacterState", name: "CharacterState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "InAir", name: "InAir", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "OnWall", name: "OnWall", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "OnWallNormX", name: "OnWallNormX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "OnWallNormY", name: "OnWallNormY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "CapturedByInertia", name: "CapturedByInertia", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "ActiveSkillId", name: "ActiveSkillId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "ActiveSkillHit", name: "ActiveSkillHit", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "FramesInvinsible", name: "FramesInvinsible", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BulletTeamId", name: "BulletTeamId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "ChCollisionTeamId", name: "ChCollisionTeamId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "RevivalVirtualGridX", name: "RevivalVirtualGridX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "RevivalVirtualGridY", name: "RevivalVirtualGridY", embedded: false, exported: true, typ: $Int32, tag: ""}]);
	InputFrameDecoded.init("", [{prop: "Dx", name: "Dx", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Dy", name: "Dy", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BtnALevel", name: "BtnALevel", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BtnBLevel", name: "BtnBLevel", embedded: false, exported: true, typ: $Int32, tag: ""}]);
	Barrier.init("", [{prop: "Boundary", name: "Boundary", embedded: false, exported: true, typ: ptrType$12, tag: ""}]);
	BulletConfig.init("", [{prop: "StartupFrames", name: "StartupFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "CancellableStFrame", name: "CancellableStFrame", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "CancellableEdFrame", name: "CancellableEdFrame", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "ActiveFrames", name: "ActiveFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "HitStunFrames", name: "HitStunFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BlockStunFrames", name: "BlockStunFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "PushbackVelX", name: "PushbackVelX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "PushbackVelY", name: "PushbackVelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Damage", name: "Damage", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "SelfLockVelX", name: "SelfLockVelX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "SelfLockVelY", name: "SelfLockVelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "HitboxOffsetX", name: "HitboxOffsetX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "HitboxOffsetY", name: "HitboxOffsetY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "HitboxSizeX", name: "HitboxSizeX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "HitboxSizeY", name: "HitboxSizeY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BlowUp", name: "BlowUp", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "ExplosionFrames", name: "ExplosionFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "SpeciesId", name: "SpeciesId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "CancelTransit", name: "CancelTransit", embedded: false, exported: true, typ: mapType, tag: ""}]);
	BulletBattleAttr.init("", [{prop: "BulletLocalId", name: "BulletLocalId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "OriginatedRenderFrameId", name: "OriginatedRenderFrameId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "OffenderJoinIndex", name: "OffenderJoinIndex", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "TeamId", name: "TeamId", embedded: false, exported: true, typ: $Int32, tag: ""}]);
	MeleeBullet.init("", [{prop: "BlState", name: "BlState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "FramesInBlState", name: "FramesInBlState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BattleAttr", name: "BattleAttr", embedded: false, exported: true, typ: ptrType, tag: ""}, {prop: "Bullet", name: "Bullet", embedded: false, exported: true, typ: ptrType$1, tag: ""}]);
	FireballBullet.init("", [{prop: "VirtualGridX", name: "VirtualGridX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VirtualGridY", name: "VirtualGridY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "DirX", name: "DirX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "DirY", name: "DirY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VelX", name: "VelX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "VelY", name: "VelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Speed", name: "Speed", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BlState", name: "BlState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "FramesInBlState", name: "FramesInBlState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BattleAttr", name: "BattleAttr", embedded: false, exported: true, typ: ptrType, tag: ""}, {prop: "Bullet", name: "Bullet", embedded: false, exported: true, typ: ptrType$1, tag: ""}]);
	Skill.init("", [{prop: "BattleLocalId", name: "BattleLocalId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "RecoveryFrames", name: "RecoveryFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "RecoveryFramesOnBlock", name: "RecoveryFramesOnBlock", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "RecoveryFramesOnHit", name: "RecoveryFramesOnHit", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "ReleaseTriggerType", name: "ReleaseTriggerType", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "BoundChState", name: "BoundChState", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Hits", name: "Hits", embedded: false, exported: true, typ: sliceType$2, tag: ""}]);
	RoomDownsyncFrame.init("", [{prop: "Id", name: "Id", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "PlayersArr", name: "PlayersArr", embedded: false, exported: true, typ: sliceType$7, tag: ""}, {prop: "CountdownNanos", name: "CountdownNanos", embedded: false, exported: true, typ: $Int64, tag: ""}, {prop: "MeleeBullets", name: "MeleeBullets", embedded: false, exported: true, typ: sliceType$8, tag: ""}, {prop: "FireballBullets", name: "FireballBullets", embedded: false, exported: true, typ: sliceType$9, tag: ""}, {prop: "BackendUnconfirmedMask", name: "BackendUnconfirmedMask", embedded: false, exported: true, typ: $Uint64, tag: ""}, {prop: "ShouldForceResync", name: "ShouldForceResync", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "BulletLocalIdCounter", name: "BulletLocalIdCounter", embedded: false, exported: true, typ: $Int32, tag: ""}]);
	InputFrameDownsync.init("", [{prop: "InputFrameId", name: "InputFrameId", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "InputList", name: "InputList", embedded: false, exported: true, typ: sliceType$3, tag: ""}, {prop: "ConfirmedList", name: "ConfirmedList", embedded: false, exported: true, typ: $Uint64, tag: ""}]);
	NpcPatrolCue.init("", [{prop: "FlAct", name: "FlAct", embedded: false, exported: true, typ: $Uint64, tag: ""}, {prop: "FrAct", name: "FrAct", embedded: false, exported: true, typ: $Uint64, tag: ""}, {prop: "X", name: "X", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "Y", name: "Y", embedded: false, exported: true, typ: $Float64, tag: ""}]);
	SkillMapperType.init([$Int, ptrType$6], [$Int], false);
	CharacterConfig.init("", [{prop: "SpeciesId", name: "SpeciesId", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "SpeciesName", name: "SpeciesName", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "InAirIdleFrameIdxTurningPoint", name: "InAirIdleFrameIdxTurningPoint", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "InAirIdleFrameIdxTurnedCycle", name: "InAirIdleFrameIdxTurnedCycle", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "LayDownFrames", name: "LayDownFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "LayDownFramesToRecover", name: "LayDownFramesToRecover", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "GetUpInvinsibleFrames", name: "GetUpInvinsibleFrames", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "GetUpFramesToRecover", name: "GetUpFramesToRecover", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "Speed", name: "Speed", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "JumpingInitVelY", name: "JumpingInitVelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "JumpingFramesToRecover", name: "JumpingFramesToRecover", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "DashingEnabled", name: "DashingEnabled", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "OnWallEnabled", name: "OnWallEnabled", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "WallJumpingFramesToRecover", name: "WallJumpingFramesToRecover", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "WallJumpingInitVelX", name: "WallJumpingInitVelX", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "WallJumpingInitVelY", name: "WallJumpingInitVelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "WallSlidingVelY", name: "WallSlidingVelY", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "InertiaFramesToRecover", name: "InertiaFramesToRecover", embedded: false, exported: true, typ: $Int32, tag: ""}, {prop: "SkillMapper", name: "SkillMapper", embedded: false, exported: true, typ: SkillMapperType, tag: ""}]);
	SatResult.init("", [{prop: "Overlap", name: "Overlap", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "OverlapX", name: "OverlapX", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "OverlapY", name: "OverlapY", embedded: false, exported: true, typ: $Float64, tag: ""}, {prop: "AContainedInB", name: "AContainedInB", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "BContainedInA", name: "BContainedInA", embedded: false, exported: true, typ: $Bool, tag: ""}, {prop: "Axis", name: "Axis", embedded: false, exported: true, typ: resolv.Vector, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = math.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = resolv.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$pkg.DIRECTION_DECODER = new sliceType$1([new sliceType([0, 0]), new sliceType([0, 2]), new sliceType([0, -2]), new sliceType([2, 0]), new sliceType([-2, 0]), new sliceType([1, 1]), new sliceType([-1, -1]), new sliceType([1, -1]), new sliceType([-1, 1])]);
		skills = $makeMap($Int.keyFor, [{ k: 1, v: new Skill.ptr(0, 30, 30, 30, 1, 2, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(7, 13, 30, 22, 13, 9, 5, 0, 5, 1, -1, 120, 0, 240, 320, false, 9, 1, $makeMap($Int.keyFor, [{ k: 1, v: 2 }])))])) }, { k: 2, v: new Skill.ptr(0, 36, 36, 36, 1, 11, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(18, 22, 36, 18, 18, 9, 5, 0, 5, 1, -1, 180, 0, 240, 320, false, 9, 1, $makeMap($Int.keyFor, [{ k: 1, v: 3 }])))])) }, { k: 3, v: new Skill.ptr(0, 50, 50, 50, 1, 12, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(8, 0, 0, 30, 999999999, 9, 20, 70, 10, 5, 50, 160, 80, 320, 320, true, 9, 1, false))])) }, { k: 4, v: new Skill.ptr(0, 30, 30, 30, 1, 2, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(7, 13, 30, 22, 13, 9, 5, 0, 5, 1, -1, 120, 0, 240, 320, false, 15, 2, $makeMap($Int.keyFor, [{ k: 1, v: 5 }])))])) }, { k: 5, v: new Skill.ptr(0, 36, 36, 36, 1, 11, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(18, 23, 36, 18, 18, 9, 5, 0, 5, 1, -1, 180, 0, 240, 320, false, 15, 2, $makeMap($Int.keyFor, [{ k: 1, v: 6 }])))])) }, { k: 6, v: new Skill.ptr(0, 45, 45, 45, 1, 12, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(8, 0, 0, 28, 999999999, 9, 20, 30, 10, -1, -1, 240, 0, 320, 320, true, 15, 2, false))])) }, { k: 7, v: new Skill.ptr(0, 30, 30, 30, 1, 2, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(7, 13, 30, 22, 13, 9, 5, 0, 5, -1, -1, 120, 0, 240, 320, false, 9, 1, $makeMap($Int.keyFor, [{ k: 1, v: 8 }])))])) }, { k: 8, v: new Skill.ptr(0, 36, 36, 36, 1, 11, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(18, 22, 36, 18, 18, 9, 5, 0, 5, 1, -1, 180, 0, 240, 320, false, 9, 1, $makeMap($Int.keyFor, [{ k: 1, v: 9 }])))])) }, { k: 9, v: new Skill.ptr(0, 40, 40, 40, 1, 12, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(7, 0, 0, 30, 999999999, 9, 20, 40, 10, 10, -1, 100, 0, 320, 320, true, 9, 1, false))])) }, { k: 10, v: new Skill.ptr(0, 38, 38, 38, 1, 13, new sliceType$2([new FireballBullet.ptr(0, 0, 0, 0, 0, 0, 60, 0, 0, ptrType.nil, new BulletConfig.ptr(10, 0, 0, 999999999, 15, 9, 20, 0, 22, -1, -1, 320, 100, 640, 480, false, 30, 1, false))])) }, { k: 11, v: new Skill.ptr(0, 60, 60, 60, 1, 14, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(3, 0, 0, 25, 999999999, 9, 20, 70, 35, 10, 80, 80, 0, 400, 640, true, 15, 3, false))])) }, { k: 12, v: new Skill.ptr(0, 10, 10, 10, 1, 15, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(3, 0, 0, 0, 0, 0, -1, -1, 0, 60, 0, 0, 0, 0, 0, false, 0, 0, false))])) }, { k: 13, v: new Skill.ptr(0, 12, 12, 12, 1, 15, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(3, 0, 0, 0, 0, 0, -1, -1, 0, 80, 0, 0, 0, 0, 0, false, 0, 0, false))])) }, { k: 14, v: new Skill.ptr(0, 8, 8, 8, 1, 15, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(4, 0, 0, 0, 999999999, 0, -1, -1, 0, 50, 0, 0, 0, 0, 0, false, 0, 0, false))])) }, { k: 15, v: new Skill.ptr(0, 48, 48, 48, 1, 13, new sliceType$2([new FireballBullet.ptr(0, 0, 0, 0, 0, 0, 40, 0, 0, ptrType.nil, new BulletConfig.ptr(12, 0, 0, 999999999, 15, 9, 30, 0, 18, -1, -1, 240, 80, 480, 320, false, 30, 2, false))])) }, { k: 16, v: new Skill.ptr(0, 60, 60, 60, 1, 13, new sliceType$2([new FireballBullet.ptr(0, 0, 0, 0, 0, 0, 40, 0, 0, ptrType.nil, new BulletConfig.ptr(16, 0, 0, 999999999, 999999999, 9, 30, 70, 30, -1, -1, 240, 80, 480, 320, true, 30, 3, false))])) }, { k: 255, v: new Skill.ptr(0, 30, 30, 30, 1, 6, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(3, 0, 0, 20, 18, 9, 5, 0, 5, -1, -1, 120, 0, 320, 240, false, 9, 1, false))])) }, { k: 256, v: new Skill.ptr(0, 20, 20, 20, 1, 6, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(3, 0, 0, 10, 15, 9, 5, 0, 5, -1, -1, 120, 0, 320, 240, false, 15, 2, false))])) }, { k: 257, v: new Skill.ptr(0, 30, 30, 30, 1, 6, new sliceType$2([new MeleeBullet.ptr(0, 0, ptrType.nil, new BulletConfig.ptr(4, 0, 0, 20, 9, 5, 5, 0, 5, -1, -1, 120, 0, 320, 240, false, 9, 1, false))])) }]);
		$pkg.Characters = $makeMap($Int.keyFor, [{ k: 0, v: new CharacterConfig.ptr(0, "MonkGirl", 11, 1, 16, 16, 10, 27, 21, 80, 2, true, true, 8, 28, 70, -10, 9, (function(patternId, currPlayerDownsync) {
			var _entry, _entry$1, _ref, _tuple, _tuple$1, currPlayerDownsync, existent1, existent2, nextSkillId, patternId, skillConfig, v, x, x$1;
			if (1 === patternId) {
				if (0 === currPlayerDownsync.FramesToRecover) {
					if (currPlayerDownsync.InAir) {
						return 255;
					} else {
						return 1;
					}
				} else {
					_tuple = (_entry = skills[$Int.keyFor(((currPlayerDownsync.ActiveSkillId >> 0)))], _entry !== undefined ? [_entry.v, true] : [ptrType$2.nil, false]);
					skillConfig = _tuple[0];
					existent1 = _tuple[1];
					if (existent1) {
						_ref = (x = skillConfig.Hits, x$1 = currPlayerDownsync.ActiveSkillHit, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1]));
						if ($assertType(_ref, ptrType$3, true)[1]) {
							v = _ref.$val;
							if (v.Bullet.CancellableStFrame <= currPlayerDownsync.FramesInChState && currPlayerDownsync.FramesInChState < v.Bullet.CancellableEdFrame) {
								_tuple$1 = (_entry$1 = v.Bullet.CancelTransit[$Int.keyFor(patternId)], _entry$1 !== undefined ? [_entry$1.v, true] : [0, false]);
								nextSkillId = _tuple$1[0];
								existent2 = _tuple$1[1];
								if (existent2) {
									return nextSkillId;
								}
							}
						}
					}
				}
			} else if (3 === patternId) {
				if ((0 === currPlayerDownsync.FramesToRecover) && !currPlayerDownsync.InAir) {
					return 15;
				}
			} else if (5 === patternId) {
				if (!currPlayerDownsync.InAir) {
					return 12;
				}
			}
			return -1;
		})) }, { k: 1, v: new CharacterConfig.ptr(1, "KnifeGirl", 9, 1, 16, 16, 10, 27, 22, 75, 2, true, true, 8, 28, 70, -10, 9, (function(patternId, currPlayerDownsync) {
			var _entry, _entry$1, _ref, _tuple, _tuple$1, currPlayerDownsync, existent1, existent2, nextSkillId, patternId, skillConfig, v, x, x$1;
			if (1 === patternId) {
				if (0 === currPlayerDownsync.FramesToRecover) {
					if (currPlayerDownsync.InAir) {
						return 256;
					} else {
						return 4;
					}
				} else {
					_tuple = (_entry = skills[$Int.keyFor(((currPlayerDownsync.ActiveSkillId >> 0)))], _entry !== undefined ? [_entry.v, true] : [ptrType$2.nil, false]);
					skillConfig = _tuple[0];
					existent1 = _tuple[1];
					if (existent1) {
						_ref = (x = skillConfig.Hits, x$1 = currPlayerDownsync.ActiveSkillHit, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1]));
						if ($assertType(_ref, ptrType$3, true)[1]) {
							v = _ref.$val;
							if (v.Bullet.CancellableStFrame <= currPlayerDownsync.FramesInChState && currPlayerDownsync.FramesInChState < v.Bullet.CancellableEdFrame) {
								_tuple$1 = (_entry$1 = v.Bullet.CancelTransit[$Int.keyFor(patternId)], _entry$1 !== undefined ? [_entry$1.v, true] : [0, false]);
								nextSkillId = _tuple$1[0];
								existent2 = _tuple$1[1];
								if (existent2) {
									return nextSkillId;
								}
							}
						}
					}
				}
			} else if (3 === patternId) {
				if ((0 === currPlayerDownsync.FramesToRecover) && !currPlayerDownsync.InAir) {
					return 16;
				}
			} else if (5 === patternId) {
				return 13;
			}
			return -1;
		})) }, { k: 4096, v: new CharacterConfig.ptr(4096, "Monk", 42, 2, 14, 14, 8, 30, 18, 78, 2, true, false, 0, 0, 0, 0, 9, (function(patternId, currPlayerDownsync) {
			var _entry, _entry$1, _ref, _tuple, _tuple$1, currPlayerDownsync, existent1, existent2, nextSkillId, patternId, skillConfig, v, x, x$1;
			if (1 === patternId) {
				if (0 === currPlayerDownsync.FramesToRecover) {
					if (currPlayerDownsync.InAir) {
						return 257;
					} else {
						return 7;
					}
				} else {
					_tuple = (_entry = skills[$Int.keyFor(((currPlayerDownsync.ActiveSkillId >> 0)))], _entry !== undefined ? [_entry.v, true] : [ptrType$2.nil, false]);
					skillConfig = _tuple[0];
					existent1 = _tuple[1];
					if (existent1) {
						_ref = (x = skillConfig.Hits, x$1 = currPlayerDownsync.ActiveSkillHit, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1]));
						if ($assertType(_ref, ptrType$3, true)[1]) {
							v = _ref.$val;
							if (v.Bullet.CancellableStFrame <= currPlayerDownsync.FramesInChState && currPlayerDownsync.FramesInChState < v.Bullet.CancellableEdFrame) {
								_tuple$1 = (_entry$1 = v.Bullet.CancelTransit[$Int.keyFor(patternId)], _entry$1 !== undefined ? [_entry$1.v, true] : [0, false]);
								nextSkillId = _tuple$1[0];
								existent2 = _tuple$1[1];
								if (existent2) {
									return nextSkillId;
								}
							}
						}
					}
				}
			} else if (2 === patternId) {
				if ((0 === currPlayerDownsync.FramesToRecover) && !currPlayerDownsync.InAir) {
					return 11;
				}
			} else if (3 === patternId) {
				if ((0 === currPlayerDownsync.FramesToRecover) && !currPlayerDownsync.InAir) {
					return 10;
				}
			} else if (5 === patternId) {
				if (!currPlayerDownsync.InAir) {
					return 14;
				}
			}
			return -1;
		})) }]);
		inAirSet = $makeMap($Int32.keyFor, [{ k: 4, v: true }, { k: 5, v: true }, { k: 6, v: true }, { k: 7, v: true }, { k: 8, v: true }, { k: 16, v: true }, { k: 15, v: true }]);
		noOpSet = $makeMap($Int32.keyFor, [{ k: 3, v: true }, { k: 7, v: true }, { k: 8, v: true }, { k: 9, v: true }, { k: 18, v: true }]);
		invinsibleSet = $makeMap($Int32.keyFor, [{ k: 8, v: true }, { k: 9, v: true }, { k: 10, v: true }, { k: 18, v: true }]);
		nonAttackingSet = $makeMap($Int32.keyFor, [{ k: 0, v: true }, { k: 1, v: true }, { k: 4, v: true }, { k: 5, v: true }, { k: 3, v: true }, { k: 7, v: true }, { k: 8, v: true }, { k: 9, v: true }, { k: 10, v: true }, { k: 18, v: true }]);
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["jsexport"] = (function() {
	var $pkg = {}, $init, js, battle, resolv, ptrType, sliceType, sliceType$1, ptrType$1, sliceType$2, ptrType$2, ptrType$3, ptrType$4, ptrType$5, funcType, funcType$1, funcType$2, funcType$3, funcType$4, funcType$5, funcType$6, ptrType$6, sliceType$3, ptrType$7, sliceType$4, ptrType$8, sliceType$5, funcType$7, funcType$8, funcType$9, funcType$10, funcType$11, funcType$12, ptrType$9, funcType$13, funcType$14, funcType$15, funcType$16, sliceType$6, funcType$17, ptrType$10, ptrType$11, mapType, sliceType$7, ptrType$12, sliceType$8, sliceType$9, sliceType$10, funcType$18, funcType$19, funcType$20, funcType$21, funcType$22, funcType$23, funcType$24, funcType$25, funcType$26, funcType$27, funcType$28, mapType$1, NewDynamicRectangleColliders, NewCollisionHolder, NewInputFrameDownsync, NewRingBufferJs, NewCollisionSpaceJs, NewVec2DJs, NewPolygon2DJs, NewBarrierJs, NewPlayerDownsyncJs, NewMeleeBulletJs, NewFireballBulletJs, NewNpcPatrolCue, NewRoomDownsyncFrameJs, GetCollisionSpaceObjsJs, GenerateConvexPolygonColliderJs, GetCharacterConfigsOrderedByJoinIndex, ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs, GetRoomDownsyncFrame, GetInputFrameDownsync, GetInput, SetInputFrameId, SetInput, SetConfirmedList, GetPlayer, GetMeleeBullet, GetFireballBullet, main;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	battle = $packages["jsexport/battle"];
	resolv = $packages["resolv"];
	ptrType = $ptrType(js.Object);
	sliceType = $sliceType(ptrType);
	sliceType$1 = $sliceType($Uint64);
	ptrType$1 = $ptrType(battle.Vec2D);
	sliceType$2 = $sliceType(ptrType$1);
	ptrType$2 = $ptrType(battle.Polygon2D);
	ptrType$3 = $ptrType(battle.CharacterConfig);
	ptrType$4 = $ptrType(battle.RoomDownsyncFrame);
	ptrType$5 = $ptrType(battle.InputFrameDownsync);
	funcType = $funcType([$Float64, $Float64], [ptrType], false);
	funcType$1 = $funcType([ptrType$1, sliceType$2], [ptrType], false);
	funcType$2 = $funcType([ptrType$2], [ptrType], false);
	funcType$3 = $funcType([$Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Bool, $Bool, $Int32, $Int32, $Bool, $Int32, $Int32, $Int32, $Int32], [ptrType], false);
	funcType$4 = $funcType([$Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Bool, $Int32, $Int32, $Int32, $Int32, $Int32], [ptrType], false);
	funcType$5 = $funcType([$Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Bool, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32, $Int32], [ptrType], false);
	funcType$6 = $funcType([$Uint64, $Uint64, $Float64, $Float64], [ptrType], false);
	ptrType$6 = $ptrType(battle.PlayerDownsync);
	sliceType$3 = $sliceType(ptrType$6);
	ptrType$7 = $ptrType(battle.MeleeBullet);
	sliceType$4 = $sliceType(ptrType$7);
	ptrType$8 = $ptrType(battle.FireballBullet);
	sliceType$5 = $sliceType(ptrType$8);
	funcType$7 = $funcType([$Int32, sliceType$3, $Int32, sliceType$4, sliceType$5], [ptrType], false);
	funcType$8 = $funcType([$Int, $Int, $Int, $Int], [ptrType], false);
	funcType$9 = $funcType([], [ptrType], false);
	funcType$10 = $funcType([$Int32, sliceType$1, $Uint64], [ptrType], false);
	funcType$11 = $funcType([$Int32], [ptrType], false);
	funcType$12 = $funcType([ptrType$2, $Float64, $Float64, $emptyInterface, $String], [ptrType], false);
	ptrType$9 = $ptrType(resolv.Space);
	funcType$13 = $funcType([ptrType$9], [sliceType], false);
	funcType$14 = $funcType([$Float64, $Float64, $Float64, $Float64, $Float64, $Float64, $Float64, $Float64, $Float64, $Float64], [$Float64, $Float64], false);
	funcType$15 = $funcType([$Float64, $Float64], [$Int32, $Int32], false);
	funcType$16 = $funcType([$Int32, $Int32], [$Float64, $Float64], false);
	sliceType$6 = $sliceType($Int);
	funcType$17 = $funcType([sliceType$6], [sliceType], false);
	ptrType$10 = $ptrType(resolv.RingBuffer);
	ptrType$11 = $ptrType(resolv.Object);
	mapType = $mapType($Int32, ptrType$11);
	sliceType$7 = $sliceType(ptrType$3);
	ptrType$12 = $ptrType(resolv.Collision);
	sliceType$8 = $sliceType(sliceType$2);
	sliceType$9 = $sliceType($Bool);
	sliceType$10 = $sliceType(ptrType$11);
	funcType$18 = $funcType([ptrType$10, $Int32, ptrType$9, mapType, $Float64, $Float64, sliceType$7, ptrType$10, ptrType$12, sliceType$2, sliceType$8, sliceType$9, sliceType$10], [$Bool], false);
	funcType$19 = $funcType([$Int32], [$Int32], false);
	funcType$20 = $funcType([$Int32], [$Bool], false);
	funcType$21 = $funcType([$Int32, $Int32, $Int32, $Int32, $Int32], [$Bool], false);
	funcType$22 = $funcType([ptrType$10, $Int32], [ptrType], false);
	funcType$23 = $funcType([ptrType$4, $Int], [ptrType], false);
	funcType$24 = $funcType([ptrType$5, $Int], [$Uint64], false);
	funcType$25 = $funcType([$Int], [sliceType], false);
	funcType$26 = $funcType([ptrType$5, $Int32], [$Bool], false);
	funcType$27 = $funcType([ptrType$5, $Int, $Uint64], [$Bool], false);
	funcType$28 = $funcType([ptrType$5, $Uint64], [$Bool], false);
	mapType$1 = $mapType($String, $emptyInterface);
	NewDynamicRectangleColliders = function(cnt) {
		var {_r, _r$1, cnt, i, ret, $s, $r, $c} = $restore(this, {cnt});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		ret = $makeSlice(sliceType, cnt);
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < cnt)) { break; } */ if(!(i < cnt)) { $s = 2; continue; }
			_r = battle.GenerateRectCollider(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $ifaceNil, ""); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_r$1 = js.MakeWrapper(_r); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			((i < 0 || i >= ret.$length) ? ($throwRuntimeError("index out of range"), undefined) : ret.$array[ret.$offset + i] = _r$1);
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return ret;
		/* */ } return; } var $f = {$blk: NewDynamicRectangleColliders, $c: true, $r, _r, _r$1, cnt, i, ret, $s};return $f;
	};
	$pkg.NewDynamicRectangleColliders = NewDynamicRectangleColliders;
	NewCollisionHolder = function() {
		return js.MakeWrapper(resolv.NewCollision());
	};
	$pkg.NewCollisionHolder = NewCollisionHolder;
	NewInputFrameDownsync = function(inputFrameId, inputList, confirmedList) {
		var confirmedList, inputFrameId, inputList;
		return js.MakeWrapper(new battle.InputFrameDownsync.ptr(inputFrameId, inputList, confirmedList));
	};
	$pkg.NewInputFrameDownsync = NewInputFrameDownsync;
	NewRingBufferJs = function(n) {
		var n;
		return js.MakeWrapper(resolv.NewRingBuffer(n));
	};
	$pkg.NewRingBufferJs = NewRingBufferJs;
	NewCollisionSpaceJs = function(spaceW, spaceH, minStepW, minStepH) {
		var minStepH, minStepW, spaceH, spaceW;
		return js.MakeWrapper(resolv.NewSpace(spaceW, spaceH, minStepW, minStepH));
	};
	$pkg.NewCollisionSpaceJs = NewCollisionSpaceJs;
	NewVec2DJs = function(x, y) {
		var x, y;
		return js.MakeWrapper(new battle.Vec2D.ptr(x, y));
	};
	$pkg.NewVec2DJs = NewVec2DJs;
	NewPolygon2DJs = function(anchor, points) {
		var anchor, points;
		return js.MakeWrapper(new battle.Polygon2D.ptr(anchor, points));
	};
	$pkg.NewPolygon2DJs = NewPolygon2DJs;
	NewBarrierJs = function(boundary) {
		var boundary;
		return js.MakeWrapper(new battle.Barrier.ptr(boundary));
	};
	$pkg.NewBarrierJs = NewBarrierJs;
	NewPlayerDownsyncJs = function(id, virtualGridX, virtualGridY, dirX, dirY, velX, velY, framesToRecover, framesInChState, activeSkillId, activeSkillHit, framesInvinsible, speed, battleState, characterState, joinIndex, hp, maxHp, colliderRadius, inAir, onWall, onWallNormX, onWallNormY, capturedByInertia, bulletTeamId, chCollisionTeamId, revivalVirtualGridX, revivalVirtualGridY) {
		var activeSkillHit, activeSkillId, battleState, bulletTeamId, capturedByInertia, chCollisionTeamId, characterState, colliderRadius, dirX, dirY, framesInChState, framesInvinsible, framesToRecover, hp, id, inAir, joinIndex, maxHp, onWall, onWallNormX, onWallNormY, revivalVirtualGridX, revivalVirtualGridY, speed, velX, velY, virtualGridX, virtualGridY;
		return js.MakeWrapper(battle.NewPlayerDownsync(id, virtualGridX, virtualGridY, dirX, dirY, velX, velY, framesToRecover, framesInChState, activeSkillId, activeSkillHit, framesInvinsible, speed, battleState, characterState, joinIndex, hp, maxHp, colliderRadius, inAir, onWall, onWallNormX, onWallNormY, capturedByInertia, bulletTeamId, chCollisionTeamId, revivalVirtualGridX, revivalVirtualGridY));
	};
	$pkg.NewPlayerDownsyncJs = NewPlayerDownsyncJs;
	NewMeleeBulletJs = function(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, teamId, blState, framesInBlState, explosionFrames, speciesId) {
		var activeFrames, blState, blockStunFrames, blowUp, bulletLocalId, cancellableEdFrame, cancellableStFrame, damage, explosionFrames, framesInBlState, hitStunFrames, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, offenderJoinIndex, originatedRenderFrameId, pushbackVelX, pushbackVelY, selfLockVelX, selfLockVelY, speciesId, startupFrames, teamId;
		return js.MakeWrapper(battle.NewMeleeBullet(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, teamId, blState, framesInBlState, explosionFrames, speciesId));
	};
	$pkg.NewMeleeBulletJs = NewMeleeBulletJs;
	NewFireballBulletJs = function(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, teamId, virtualGridX, virtualGridY, dirX, dirY, velX, velY, speed, blState, framesInBlState, explosionFrames, speciesId) {
		var activeFrames, blState, blockStunFrames, blowUp, bulletLocalId, cancellableEdFrame, cancellableStFrame, damage, dirX, dirY, explosionFrames, framesInBlState, hitStunFrames, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, offenderJoinIndex, originatedRenderFrameId, pushbackVelX, pushbackVelY, selfLockVelX, selfLockVelY, speciesId, speed, startupFrames, teamId, velX, velY, virtualGridX, virtualGridY;
		return js.MakeWrapper(battle.NewFireballBullet(bulletLocalId, originatedRenderFrameId, offenderJoinIndex, startupFrames, cancellableStFrame, cancellableEdFrame, activeFrames, hitStunFrames, blockStunFrames, pushbackVelX, pushbackVelY, damage, selfLockVelX, selfLockVelY, hitboxOffsetX, hitboxOffsetY, hitboxSizeX, hitboxSizeY, blowUp, teamId, virtualGridX, virtualGridY, dirX, dirY, velX, velY, speed, blState, framesInBlState, explosionFrames, speciesId));
	};
	$pkg.NewFireballBulletJs = NewFireballBulletJs;
	NewNpcPatrolCue = function(flAct, frAct, x, y) {
		var flAct, frAct, x, y;
		return js.MakeWrapper(new battle.NpcPatrolCue.ptr(flAct, frAct, x, y));
	};
	$pkg.NewNpcPatrolCue = NewNpcPatrolCue;
	NewRoomDownsyncFrameJs = function(id, playersArr, bulletLocalIdCounter, meleeBullets, fireballBullets) {
		var bulletLocalIdCounter, fireballBullets, id, meleeBullets, playersArr, preallocatedRdf;
		preallocatedRdf = battle.NewPreallocatedRoomDownsyncFrame(playersArr.$length, 64, 64);
		battle.CloneRoomDownsyncFrame(id, playersArr, bulletLocalIdCounter, meleeBullets, fireballBullets, preallocatedRdf);
		return js.MakeWrapper(preallocatedRdf);
	};
	$pkg.NewRoomDownsyncFrameJs = NewRoomDownsyncFrameJs;
	GetCollisionSpaceObjsJs = function(space) {
		var _i, _ref, i, obj, objs, ret, space;
		objs = space.Objects();
		ret = $makeSlice(sliceType, objs.$length);
		_ref = objs;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			obj = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= ret.$length) ? ($throwRuntimeError("index out of range"), undefined) : ret.$array[ret.$offset + i] = js.MakeWrapper(obj));
			_i++;
		}
		return ret;
	};
	$pkg.GetCollisionSpaceObjsJs = GetCollisionSpaceObjsJs;
	GenerateConvexPolygonColliderJs = function(unalignedSrc, spaceOffsetX, spaceOffsetY, data, tag) {
		var {$24r, _r, _r$1, data, spaceOffsetX, spaceOffsetY, tag, unalignedSrc, $s, $r, $c} = $restore(this, {unalignedSrc, spaceOffsetX, spaceOffsetY, data, tag});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = battle.GenerateConvexPolygonCollider(unalignedSrc, spaceOffsetX, spaceOffsetY, data, tag); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = js.MakeWrapper(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: GenerateConvexPolygonColliderJs, $c: true, $r, $24r, _r, _r$1, data, spaceOffsetX, spaceOffsetY, tag, unalignedSrc, $s};return $f;
	};
	$pkg.GenerateConvexPolygonColliderJs = GenerateConvexPolygonColliderJs;
	GetCharacterConfigsOrderedByJoinIndex = function(speciesIdList) {
		var {_entry, _i, _r, _ref, i, ret, speciesId, speciesIdList, $s, $r, $c} = $restore(this, {speciesIdList});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		ret = $makeSlice(sliceType, speciesIdList.$length, speciesIdList.$length);
		_ref = speciesIdList;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			i = _i;
			speciesId = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_r = js.MakeFullWrapper((_entry = battle.Characters[$Int.keyFor(speciesId)], _entry !== undefined ? _entry.v : ptrType$3.nil)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			((i < 0 || i >= ret.$length) ? ($throwRuntimeError("index out of range"), undefined) : ret.$array[ret.$offset + i] = _r);
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return ret;
		/* */ } return; } var $f = {$blk: GetCharacterConfigsOrderedByJoinIndex, $c: true, $r, _entry, _i, _r, _ref, i, ret, speciesId, speciesIdList, $s};return $f;
	};
	$pkg.GetCharacterConfigsOrderedByJoinIndex = GetCharacterConfigsOrderedByJoinIndex;
	ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs = function(inputsBuffer, currRenderFrameId, collisionSys, collisionSysMap, collisionSpaceOffsetX, collisionSpaceOffsetY, chConfigsOrderedByJoinIndex, renderFrameBuffer, collision, effPushbacks, hardPushbackNormsArr, jumpedOrNotList, dynamicRectangleColliders) {
		var {$24r, _r, chConfigsOrderedByJoinIndex, collision, collisionSpaceOffsetX, collisionSpaceOffsetY, collisionSys, collisionSysMap, currRenderFrameId, dynamicRectangleColliders, effPushbacks, hardPushbackNormsArr, inputsBuffer, jumpedOrNotList, renderFrameBuffer, $s, $r, $c} = $restore(this, {inputsBuffer, currRenderFrameId, collisionSys, collisionSysMap, collisionSpaceOffsetX, collisionSpaceOffsetY, chConfigsOrderedByJoinIndex, renderFrameBuffer, collision, effPushbacks, hardPushbackNormsArr, jumpedOrNotList, dynamicRectangleColliders});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = battle.ApplyInputFrameDownsyncDynamicsOnSingleRenderFrame(inputsBuffer, currRenderFrameId, collisionSys, collisionSysMap, collisionSpaceOffsetX, collisionSpaceOffsetY, chConfigsOrderedByJoinIndex, renderFrameBuffer, collision, effPushbacks, hardPushbackNormsArr, jumpedOrNotList, dynamicRectangleColliders); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs, $c: true, $r, $24r, _r, chConfigsOrderedByJoinIndex, collision, collisionSpaceOffsetX, collisionSpaceOffsetY, collisionSys, collisionSysMap, currRenderFrameId, dynamicRectangleColliders, effPushbacks, hardPushbackNormsArr, inputsBuffer, jumpedOrNotList, renderFrameBuffer, $s};return $f;
	};
	$pkg.ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs = ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs;
	GetRoomDownsyncFrame = function(renderFrameBuffer, frameId) {
		var candidate, frameId, renderFrameBuffer;
		candidate = renderFrameBuffer.GetByFrameId(frameId);
		if ($interfaceIsEqual($ifaceNil, candidate)) {
			return null;
		}
		return js.MakeWrapper($assertType(candidate, ptrType$4));
	};
	$pkg.GetRoomDownsyncFrame = GetRoomDownsyncFrame;
	GetInputFrameDownsync = function(inputsBuffer, inputFrameId) {
		var candidate, inputFrameId, inputsBuffer;
		candidate = inputsBuffer.GetByFrameId(inputFrameId);
		if ($interfaceIsEqual($ifaceNil, candidate)) {
			return null;
		}
		return js.MakeWrapper($assertType(candidate, ptrType$5));
	};
	$pkg.GetInputFrameDownsync = GetInputFrameDownsync;
	GetInput = function(ifd, i) {
		var i, ifd, x;
		return (x = ifd.InputList, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
	};
	$pkg.GetInput = GetInput;
	SetInputFrameId = function(ifd, newVal) {
		var ifd, newVal;
		ifd.InputFrameId = newVal;
		return true;
	};
	$pkg.SetInputFrameId = SetInputFrameId;
	SetInput = function(ifd, i, newVal) {
		var i, ifd, newVal, x;
		if (i >= ifd.InputList.$length) {
			return false;
		}
		(x = ifd.InputList, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i] = newVal));
		return true;
	};
	$pkg.SetInput = SetInput;
	SetConfirmedList = function(ifd, newVal) {
		var ifd, newVal;
		ifd.ConfirmedList = newVal;
		return true;
	};
	$pkg.SetConfirmedList = SetConfirmedList;
	GetPlayer = function(rdf, i) {
		var i, rdf, x;
		return js.MakeWrapper((x = rdf.PlayersArr, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	$pkg.GetPlayer = GetPlayer;
	GetMeleeBullet = function(rdf, i) {
		var i, rdf, x, x$1;
		if (-1 === (x = rdf.MeleeBullets, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])).GetBulletLocalId()) {
			return null;
		}
		return js.MakeWrapper((x$1 = rdf.MeleeBullets, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])));
	};
	$pkg.GetMeleeBullet = GetMeleeBullet;
	GetFireballBullet = function(rdf, i) {
		var i, rdf, x, x$1;
		if (-1 === (x = rdf.FireballBullets, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])).GetBulletLocalId()) {
			return null;
		}
		return js.MakeWrapper((x$1 = rdf.FireballBullets, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])));
	};
	$pkg.GetFireballBullet = GetFireballBullet;
	main = function() {
		$global.gopkgs = $externalize($makeMap($String.keyFor, [{ k: "NewVec2DJs", v: new funcType(NewVec2DJs) }, { k: "NewPolygon2DJs", v: new funcType$1(NewPolygon2DJs) }, { k: "NewBarrierJs", v: new funcType$2(NewBarrierJs) }, { k: "NewPlayerDownsyncJs", v: new funcType$3(NewPlayerDownsyncJs) }, { k: "NewMeleeBulletJs", v: new funcType$4(NewMeleeBulletJs) }, { k: "NewFireballBulletJs", v: new funcType$5(NewFireballBulletJs) }, { k: "NewNpcPatrolCue", v: new funcType$6(NewNpcPatrolCue) }, { k: "NewRoomDownsyncFrameJs", v: new funcType$7(NewRoomDownsyncFrameJs) }, { k: "NewCollisionSpaceJs", v: new funcType$8(NewCollisionSpaceJs) }, { k: "NewCollisionHolder", v: new funcType$9(NewCollisionHolder) }, { k: "NewInputFrameDownsync", v: new funcType$10(NewInputFrameDownsync) }, { k: "NewRingBufferJs", v: new funcType$11(NewRingBufferJs) }, { k: "GenerateConvexPolygonColliderJs", v: new funcType$12(GenerateConvexPolygonColliderJs) }, { k: "GetCollisionSpaceObjsJs", v: new funcType$13(GetCollisionSpaceObjsJs) }, { k: "WorldToPolygonColliderBLPos", v: new funcType$14(battle.WorldToPolygonColliderBLPos) }, { k: "PolygonColliderBLToWorldPos", v: new funcType$14(battle.PolygonColliderBLToWorldPos) }, { k: "WorldToVirtualGridPos", v: new funcType$15(battle.WorldToVirtualGridPos) }, { k: "VirtualGridToWorldPos", v: new funcType$16(battle.VirtualGridToWorldPos) }, { k: "GetCharacterConfigsOrderedByJoinIndex", v: new funcType$17(GetCharacterConfigsOrderedByJoinIndex) }, { k: "ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs", v: new funcType$18(ApplyInputFrameDownsyncDynamicsOnSingleRenderFrameJs) }, { k: "ConvertToDelayedInputFrameId", v: new funcType$19(battle.ConvertToDelayedInputFrameId) }, { k: "ConvertToNoDelayInputFrameId", v: new funcType$19(battle.ConvertToNoDelayInputFrameId) }, { k: "ConvertToFirstUsedRenderFrameId", v: new funcType$19(battle.ConvertToFirstUsedRenderFrameId) }, { k: "ConvertToLastUsedRenderFrameId", v: new funcType$19(battle.ConvertToLastUsedRenderFrameId) }, { k: "ShouldGenerateInputFrameUpsync", v: new funcType$20(battle.ShouldGenerateInputFrameUpsync) }, { k: "IsGeneralBulletActive", v: new funcType$21(battle.IsGeneralBulletActive) }, { k: "GetRoomDownsyncFrame", v: new funcType$22(GetRoomDownsyncFrame) }, { k: "GetInputFrameDownsync", v: new funcType$22(GetInputFrameDownsync) }, { k: "GetPlayer", v: new funcType$23(GetPlayer) }, { k: "GetMeleeBullet", v: new funcType$23(GetMeleeBullet) }, { k: "GetFireballBullet", v: new funcType$23(GetFireballBullet) }, { k: "GetInput", v: new funcType$24(GetInput) }, { k: "NewDynamicRectangleColliders", v: new funcType$25(NewDynamicRectangleColliders) }, { k: "SetInputFrameId", v: new funcType$26(SetInputFrameId) }, { k: "SetInput", v: new funcType$27(SetInput) }, { k: "SetConfirmedList", v: new funcType$28(SetConfirmedList) }]), mapType$1);
	};
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = battle.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = resolv.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		if ($pkg === $mainPkg) {
			main();
			$mainFinished = true;
		}
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$synthesizeMethods();
$initAllLinknames();
var $mainPkg = $packages["jsexport"];
$packages["runtime"].$init();
$go($mainPkg.$init, []);
$flushConsole();

}).call(this);
//# sourceMappingURL=jsexport.js.map

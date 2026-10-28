'use strict';
/** Tiny declarative validator. Each rule returns the cleaned value or throws a message string. */
const { HttpError } = require('./http');

const stripCtl = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

const v = {
  str: ({ min = 0, max = 200, optional = false, pattern, trim = true, multiline = false } = {}) => (val) => {
    if (val === undefined || val === null || val === '') {
      if (optional) return null;
      throw 'is required';
    }
    if (typeof val !== 'string') throw 'must be text';
    let s = stripCtl(trim ? val.trim() : val);
    if (!multiline) s = s.replace(/\s+/g, ' ');
    if (!s && !optional) throw 'is required';
    if (!s) return null;
    if (s.length < min) throw `must be at least ${min} characters`;
    if (s.length > max) throw `must be at most ${max} characters`;
    if (pattern && !pattern.test(s)) throw 'is not valid';
    return s;
  },
  email: ({ optional = false } = {}) => (val) => {
    const s = v.str({ max: 254, optional })(val);
    if (s === null) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw 'must be a valid email address';
    return s.toLowerCase();
  },
  phone: ({ optional = false } = {}) => (val) => {
    const s = v.str({ max: 20, optional })(val);
    if (s === null) return null;
    let digits = s.replace(/[\s\-()]/g, '');
    if (/^\+233\d{9}$/.test(digits)) digits = '0' + digits.slice(4);
    else if (/^233\d{9}$/.test(digits)) digits = '0' + digits.slice(3);
    if (!/^0\d{9}$/.test(digits)) throw 'must be a valid Ghana phone number (e.g. 024 123 4567)';
    return digits;
  },
  int: ({ min = -Infinity, max = Infinity, optional = false } = {}) => (val) => {
    if (val === undefined || val === null || val === '') { if (optional) return null; throw 'is required'; }
    const n = typeof val === 'string' && /^-?\d+$/.test(val.trim()) ? Number(val) : val;
    if (!Number.isInteger(n)) throw 'must be a whole number';
    if (n < min || n > max) throw `must be between ${min} and ${max}`;
    return n;
  },
  bool: ({ optional = false } = {}) => (val) => {
    if (val === undefined || val === null) { if (optional) return null; throw 'is required'; }
    if (typeof val !== 'boolean') throw 'must be true or false';
    return val;
  },
  oneOf: (values, { optional = false } = {}) => (val) => {
    if (val === undefined || val === null || val === '') { if (optional) return null; throw 'is required'; }
    if (!values.includes(val)) throw 'is not an allowed value';
    return val;
  },
  password: () => (val) => {
    if (typeof val !== 'string' || !val) throw 'is required';
    if (val.length < 8) throw 'must be at least 8 characters';
    if (val.length > 200) throw 'is too long';
    return val;
  },
  array: (item, { min = 0, max = 100 } = {}) => (val) => {
    if (!Array.isArray(val)) throw 'must be a list';
    if (val.length < min) throw `must have at least ${min} item(s)`;
    if (val.length > max) throw `must have at most ${max} items`;
    return val.map((x, i) => {
      try { return item(x); } catch (e) { throw `item ${i + 1} ${typeof e === 'string' ? e : 'is invalid'}`; }
    });
  },
  object: (shape) => (val) => validate(shape, val)
};

function validate(shape, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected a JSON object');
  const out = {};
  const fields = {};
  for (const [key, rule] of Object.entries(shape)) {
    try {
      out[key] = rule(input[key]);
    } catch (e) {
      if (e instanceof HttpError) {
        fields[key] = e.fields ? Object.values(e.fields)[0] : e.message;
      } else {
        fields[key] = typeof e === 'string' ? e : 'is invalid';
      }
    }
  }
  if (Object.keys(fields).length) {
    const [k, msg] = Object.entries(fields)[0];
    throw new HttpError(422, `${label(k)} ${msg}`, { code: 'validation_error', fields });
  }
  return out;
}

function label(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

module.exports = { v, validate };

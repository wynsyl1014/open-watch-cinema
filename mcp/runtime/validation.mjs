export function requireObject(value, label = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

export function requireString(value, label, { min = 1, max = 4000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new TypeError(`${label} must be a string between ${min} and ${max} characters.`);
  }
  return value;
}

export function optionalString(value, label, options) {
  return value === undefined || value === null ? undefined : requireString(value, label, options);
}

export function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function cinemaError(code, message, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

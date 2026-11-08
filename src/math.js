/**
 * Math helpers.
 * @module math
 */

/**
 * Add two numbers.
 * @param {number} a - First addend (must be a finite number).
 * @param {number} b - Second addend (must be a finite number).
 * @returns {number} The sum of a and b.
 * @throws {TypeError} If either argument is not a finite number.
 */
function add(a, b) {
  if (typeof a !== 'number' || !Number.isFinite(a)) {
    throw new TypeError('add: first argument must be a finite number');
  }
  if (typeof b !== 'number' || !Number.isFinite(b)) {
    throw new TypeError('add: second argument must be a finite number');
  }
  return a + b;
}

module.exports = { add };

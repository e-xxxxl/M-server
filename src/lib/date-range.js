import mongoose from "mongoose";

/**
 * A from/to pair of calendar days (YYYY-MM-DD) as a database range. The days are Nigerian days: from the first moment of
 * "from" to the last moment of "to", in West Africa Time (UTC+1). Returns null when neither is given.
 */
export function lagosRange({ from, to } = {}) {
  const range = {};
  if (from) range.$gte = new Date(`${from}T00:00:00+01:00`);
  if (to) range.$lte = new Date(`${to}T23:59:59.999+01:00`);
  return Object.keys(range).length > 0 ? mongoose.trusted(range) : null;
}

/**
 * Shared Pagination & Date Filtering Middleware
 * Validates and normalizes limit, offset, since, and until query parameters.
 */

function parsePagination(req, res, next) {
  const { limit: rawLimit, offset: rawOffset, since: rawSince, until: rawUntil } = req.query || {};

  let limit = 50;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" && typeof rawLimit !== "number") {
      return res.status(400).json({ message: "Invalid 'limit' parameter: must be a positive integer." });
    }
    const strLimit = String(rawLimit).trim();
    if (!/^\d+$/.test(strLimit)) {
      return res.status(400).json({ message: "Invalid 'limit' parameter: must be a positive integer." });
    }
    const parsedLimit = parseInt(strLimit, 10);
    if (parsedLimit < 1) {
      return res.status(400).json({ message: "Invalid 'limit' parameter: must be a positive integer." });
    }
    limit = Math.min(200, parsedLimit);
  }

  let offset = 0;
  if (rawOffset !== undefined) {
    if (typeof rawOffset !== "string" && typeof rawOffset !== "number") {
      return res.status(400).json({ message: "Invalid 'offset' parameter: must be a non-negative integer." });
    }
    const strOffset = String(rawOffset).trim();
    if (!/^\d+$/.test(strOffset)) {
      return res.status(400).json({ message: "Invalid 'offset' parameter: must be a non-negative integer." });
    }
    offset = parseInt(strOffset, 10);
  }

  let since;
  if (rawSince !== undefined) {
    if (typeof rawSince !== "string" && !(rawSince instanceof Date)) {
      return res.status(400).json({ message: "Invalid 'since' date parameter." });
    }
    if (typeof rawSince === "string" && !rawSince.trim()) {
      return res.status(400).json({ message: "Invalid 'since' date parameter." });
    }
    const d = new Date(rawSince);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ message: "Invalid 'since' date parameter." });
    }
    since = d;
  }

  let until;
  if (rawUntil !== undefined) {
    if (typeof rawUntil !== "string" && !(rawUntil instanceof Date)) {
      return res.status(400).json({ message: "Invalid 'until' date parameter." });
    }
    if (typeof rawUntil === "string" && !rawUntil.trim()) {
      return res.status(400).json({ message: "Invalid 'until' date parameter." });
    }
    const d = new Date(rawUntil);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ message: "Invalid 'until' date parameter." });
    }
    until = d;
  }

  req.pagination = { limit, offset, since, until };
  return next();
}

parsePagination.parsePagination = parsePagination;
module.exports = parsePagination;
module.exports.parsePagination = parsePagination;

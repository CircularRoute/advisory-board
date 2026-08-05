// Parse a reviewer's FINAL RANKING block. Strict regex after the marker,
// with a fallback scan; parse failure is reported explicitly, never
// silently dropped.

export function parseRanking(text, expectedLabels) {
  const markerMatches = [...text.matchAll(/FINAL RANKING:/gi)];
  const region = markerMatches.length
    ? text.slice(markerMatches[markerMatches.length - 1].index)
    : null;

  if (region) {
    const strict = [...region.matchAll(/^\s*\d+[.)]\s*Response\s+([A-Z])\b.*$/gim)].map(
      (m) => m[1]
    );
    if (isValid(strict, expectedLabels)) return { ranking: strict, method: "strict" };

    // Fallback: first appearance order of each expected label after the marker.
    const seen = [];
    for (const m of region.matchAll(/Response\s+([A-Z])\b/g)) {
      if (expectedLabels.includes(m[1]) && !seen.includes(m[1])) seen.push(m[1]);
    }
    if (isValid(seen, expectedLabels)) return { ranking: seen, method: "fallback" };
    return {
      ranking: null,
      error: `FINAL RANKING block found but could not be parsed into a complete ranking of [${expectedLabels.join(", ")}]`,
    };
  }

  return { ranking: null, error: "no FINAL RANKING marker found in review" };
}

function isValid(labels, expected) {
  return (
    labels.length === expected.length &&
    new Set(labels).size === labels.length &&
    labels.every((l) => expected.includes(l))
  );
}

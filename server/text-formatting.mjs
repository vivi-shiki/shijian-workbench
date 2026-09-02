const FORMATTING = /[\p{P}\p{Z}\s]/u;

export function textSignature(value) {
  return [...String(value || "").normalize("NFC")].filter(character => !FORMATTING.test(character)).join("");
}

function formattedParts(value) {
  const characters = [];
  const gaps = [""];
  for (const character of String(value || "").normalize("NFC")) {
    if (FORMATTING.test(character)) gaps[gaps.length - 1] += character;
    else {
      characters.push(character);
      gaps.push("");
    }
  }
  return { characters, gaps };
}

export function projectFormatting(source, formatted) {
  const sourceCharacters = [...textSignature(source)];
  const candidate = formattedParts(formatted);
  const rows = sourceCharacters.length + 1;
  const columns = candidate.characters.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    for (let candidateIndex = 1; candidateIndex < columns; candidateIndex += 1) {
      lcs[sourceIndex][candidateIndex] = sourceCharacters[sourceIndex - 1] === candidate.characters[candidateIndex - 1]
        ? lcs[sourceIndex - 1][candidateIndex - 1] + 1
        : Math.max(lcs[sourceIndex - 1][candidateIndex], lcs[sourceIndex][candidateIndex - 1]);
    }
  }

  const matches = [];
  let sourceIndex = sourceCharacters.length;
  let candidateIndex = candidate.characters.length;
  while (sourceIndex > 0 && candidateIndex > 0) {
    if (sourceCharacters[sourceIndex - 1] === candidate.characters[candidateIndex - 1]) {
      matches.push({ source: sourceIndex - 1, candidate: candidateIndex - 1 });
      sourceIndex -= 1;
      candidateIndex -= 1;
    } else if (lcs[sourceIndex - 1][candidateIndex] >= lcs[sourceIndex][candidateIndex - 1]) sourceIndex -= 1;
    else candidateIndex -= 1;
  }
  matches.reverse();

  const sourceGaps = Array(sourceCharacters.length + 1).fill("");
  let matchCursor = 0;
  for (let gapIndex = 0; gapIndex < candidate.gaps.length; gapIndex += 1) {
    const gap = candidate.gaps[gapIndex];
    if (!gap) continue;
    while (matchCursor < matches.length && matches[matchCursor].candidate < gapIndex) matchCursor += 1;
    const previous = matches[matchCursor - 1];
    const next = matches[matchCursor];
    const boundary = next ? next.source : previous ? previous.source + 1 : 0;
    sourceGaps[boundary] += gap;
  }

  let text = sourceGaps[0];
  for (let index = 0; index < sourceCharacters.length; index += 1) text += sourceCharacters[index] + sourceGaps[index + 1];
  const similarity = matches.length / Math.max(1, sourceCharacters.length, candidate.characters.length);
  return { text: text.trim(), similarity };
}

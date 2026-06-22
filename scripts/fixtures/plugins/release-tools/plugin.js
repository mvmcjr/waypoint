// release-tools — create the next versioned release branch.
//
// Reads existing release/vX.Y.Z refs, computes the next version per the chosen
// bump, and creates (and checks out) a new release branch off HEAD.
// Self-contained ESM (no imports): the sandbox has no module resolver.

function parseRelease(shorthand) {
  const m = shorthand.match(/release\/v(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export const commands = {
  "create-release": async (ctx, api, inputs) => {
    if (!ctx.headOid) throw new Error("No HEAD commit to branch from.");

    const refs = await api.listRefs();
    const versions = refs
      .map((r) => parseRelease(r.shorthand))
      .filter(Boolean)
      .sort(compare);

    const latest = versions.length ? versions[versions.length - 1] : [0, 0, 0];
    let [major, minor, patch] = latest;

    switch (inputs.bump) {
      case "major": major += 1; minor = 0; patch = 0; break;
      case "minor": minor += 1; patch = 0; break;
      default:      patch += 1; break;
    }

    const name = `release/v${major}.${minor}.${patch}`;
    await api.createBranch(name, ctx.headOid, true);
    // To also publish it, a remote-aware plugin could: await api.push("origin", name);
    return `Created ${name}`;
  },
};

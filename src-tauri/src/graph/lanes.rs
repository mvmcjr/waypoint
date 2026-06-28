use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct CommitNode {
    pub oid: String,
    pub parent_oids: Vec<String>,
    pub summary: String,
    /// Commit message body (everything after the summary line), trimmed. Empty when none.
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub refs: Vec<String>,
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from_lane: usize,
    pub to_lane: usize,
    pub color_idx: usize,
    pub from_row: usize,
    pub to_row: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PositionedCommit {
    pub commit: CommitNode,
    pub lane: usize,
    pub row: usize,
    pub color_idx: usize,
    pub edges: Vec<GraphEdge>,
}

/// Assign lanes to a topologically-sorted (newest-first) commit list.
///
/// Key invariant: when a commit's first parent lives on a *different* lane,
/// the commit's own lane is kept as a "routing entry" (holding the parent's
/// id) so subsequent commits cannot reuse that slot.  When the parent is
/// eventually processed it clears all routing duplicates of its id and
/// collapses back to its canonical lane.  This gives every independent
/// branch its own dedicated X-axis column.
///
/// Performance: OIDs are interned to dense `u32` ids up front so the per-commit
/// lane scans compare integers (and never allocate) instead of cloning and
/// byte-comparing 40-char hex strings. On wide graphs (100+ lanes, thousands of
/// commits) this is the difference between a snappy and a sluggish re-walk.
pub fn assign_lanes(commits: Vec<CommitNode>) -> Vec<PositionedCommit> {
    let n = commits.len();

    // ── Interning ─────────────────────────────────────────────────────────
    // Each commit's id is simply its row index (commits are unique and ordered
    // newest-first). Parent OIDs are resolved to that same id; a parent outside
    // the walk window (e.g. truncated by a limit) gets a synthetic id >= n that
    // is never processed, so its lane slot stays occupied just like before.
    let mut oid_to_id: HashMap<&str, u32> = HashMap::with_capacity(n);
    for (i, c) in commits.iter().enumerate() {
        oid_to_id.insert(c.oid.as_str(), i as u32);
    }
    let mut next_extra = n as u32;
    let mut parents_id: Vec<Vec<u32>> = Vec::with_capacity(n);
    for c in &commits {
        let mut pv = Vec::with_capacity(c.parent_oids.len());
        for p in &c.parent_oids {
            let id = match oid_to_id.get(p.as_str()) {
                Some(&id) => id,
                None => {
                    let id = next_extra;
                    next_extra += 1;
                    id
                }
            };
            pv.push(id);
        }
        parents_id.push(pv);
    }
    drop(oid_to_id);

    // lane index → id that currently owns the slot (u32::MAX = free).
    const FREE: u32 = u32::MAX;
    let mut lanes: Vec<u32> = Vec::new();
    // id → color index so first-parent chains share a color.
    let mut color_of: HashMap<u32, usize> = HashMap::new();
    let mut next_color: usize = 0;

    // Per-row outputs, collected now and zipped with the moved commits later.
    let mut row_lane: Vec<usize> = vec![0; n];
    let mut row_color: Vec<usize> = vec![0; n];
    let mut row_edges: Vec<Vec<GraphEdge>> = Vec::with_capacity(n);

    for row in 0..n {
        let cid = row as u32;

        // ── 1. Find this commit's canonical lane ─────────────────────────
        let commit_lane = lanes
            .iter()
            .position(|&s| s == cid)
            .unwrap_or_else(|| {
                if let Some(free) = lanes.iter().position(|&s| s == FREE) {
                    free
                } else {
                    lanes.push(FREE);
                    lanes.len() - 1
                }
            });
        lanes[commit_lane] = cid;

        // ── 2. Clear routing duplicates ───────────────────────────────────
        for slot in lanes.iter_mut() {
            if *slot == cid {
                *slot = FREE;
            }
        }
        lanes[commit_lane] = cid;

        // ── 3. Assign color ───────────────────────────────────────────────
        let color_idx = *color_of.entry(cid).or_insert_with(|| {
            let c = next_color % 8;
            next_color += 1;
            c
        });

        // ── 4. Allocate lanes for each parent ─────────────────────────────
        // commit_lane is still occupied here (not freed yet) so second/third
        // parents won't accidentally reuse it.
        let mut edges: Vec<GraphEdge> = Vec::with_capacity(parents_id[row].len());

        for (i, &pid) in parents_id[row].iter().enumerate() {
            let target_lane = if let Some(existing) = lanes.iter().position(|&s| s == pid) {
                // Parent already has a lane (pre-allocated by another child).
                existing
            } else if i == 0 {
                // First parent inherits this commit's lane.
                commit_lane
            } else {
                // Merge parent: find a free slot or grow.
                if let Some(free) = lanes.iter().position(|&s| s == FREE) {
                    free
                } else {
                    lanes.push(FREE);
                    lanes.len() - 1
                }
            };

            if target_lane >= lanes.len() {
                lanes.resize(target_lane + 1, FREE);
            }
            // Claim the slot for this parent (may overwrite commit's own id
            // when target_lane == commit_lane — that is intentional).
            lanes[target_lane] = pid;

            // Color: first parent inherits commit's color; others get a new one.
            // For the first-parent claim we take MIN(existing, current) so that
            // a "main-ier" chain (lower color_idx, claimed earlier in the walk)
            // wins out over a side branch that happened to reach this parent
            // first. Without this, e.g. a renovate branch processed before the
            // trunk would stamp the trunk's lane its own color from the
            // convergence point downward.
            let edge_color = if i == 0 {
                let entry = color_of.entry(pid).or_insert(color_idx);
                if color_idx < *entry {
                    *entry = color_idx;
                }
                color_idx
            } else {
                *color_of.entry(pid).or_insert_with(|| {
                    let c = next_color % 8;
                    next_color += 1;
                    c
                })
            };

            edges.push(GraphEdge {
                from_lane: commit_lane,
                to_lane: target_lane,
                color_idx: edge_color,
                from_row: row,
                to_row: 0, // filled in the second pass
            });
        }

        // ── 5. Keep commit_lane as a routing entry when needed ────────────
        // If the first parent ended up on a *different* lane (it was already
        // pre-allocated elsewhere), commit_lane is still holding commit's id.
        // Replace it with the first parent's id so the lane slot stays
        // occupied — preventing other commits from reusing it — until the
        // parent is actually processed and clears it in step 2 above.
        if let Some(&first_parent) = parents_id[row].first() {
            if lanes[commit_lane] == cid {
                // First parent did NOT inherit commit_lane → need routing.
                lanes[commit_lane] = first_parent;
            }
            // Else: first parent already wrote its id into commit_lane → done.
        } else {
            // Root commit (no parents): free the lane.
            lanes[commit_lane] = FREE;
        }

        row_lane[row] = commit_lane;
        row_color[row] = color_idx;
        row_edges.push(edges);
    }

    // ── Second pass: fill in to_row + to_lane for every edge ──────────────
    // edges[i] corresponds to parents_id[row][i] (same iteration order).
    //
    // to_lane is rewritten here because the lane recorded during step 4 was
    // whichever slot the parent was preallocated in at the time — but step 2,
    // when the parent itself is processed later, collapses all routing
    // duplicates back to the parent's first occurrence. The parent dot ends up
    // at that first-occurrence lane, so the edge endpoint has to match.
    //
    // A parent's id (when < n) is exactly its row, so to_row = pid and
    // to_lane = row_lane[pid] are O(1) lookups — no maps needed. Synthetic
    // out-of-window parents (id >= n) keep the default to_row = 0.
    for row in 0..n {
        for (edge_idx, edge) in row_edges[row].iter_mut().enumerate() {
            let pid = parents_id[row][edge_idx];
            if (pid as usize) < n {
                edge.to_row = pid as usize;
                edge.to_lane = row_lane[pid as usize];
            }
        }
    }

    // ── Assemble: move each CommitNode into its PositionedCommit ───────────
    commits
        .into_iter()
        .enumerate()
        .map(|(row, commit)| PositionedCommit {
            commit,
            lane: row_lane[row],
            row,
            color_idx: row_color[row],
            edges: std::mem::take(&mut row_edges[row]),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a CommitNode with just the fields the layout cares about.
    fn node(oid: &str, parents: &[&str]) -> CommitNode {
        CommitNode {
            oid: oid.to_owned(),
            parent_oids: parents.iter().map(|s| s.to_string()).collect(),
            summary: String::new(),
            body: String::new(),
            author_name: String::new(),
            author_email: String::new(),
            timestamp: 0,
            refs: Vec::new(),
            local_branches: Vec::new(),
            remote_branches: Vec::new(),
        }
    }

    fn by_oid<'a>(r: &'a [PositionedCommit], oid: &str) -> &'a PositionedCommit {
        r.iter().find(|p| p.commit.oid == oid).expect("oid present")
    }

    #[test]
    fn linear_history_stays_on_one_lane() {
        // c -> b -> a (newest first)
        let r = assign_lanes(vec![node("c", &["b"]), node("b", &["a"]), node("a", &[])]);
        assert_eq!(r.len(), 3);
        for p in &r {
            assert_eq!(p.lane, 0, "linear chain must occupy lane 0");
        }
        // Rows are the input order.
        assert_eq!(by_oid(&r, "c").row, 0);
        assert_eq!(by_oid(&r, "a").row, 2);
        // First-parent chain shares a single color.
        assert!(r.iter().all(|p| p.color_idx == 0));
        // Each non-root edge points straight down to its parent's row, same lane.
        let c = by_oid(&r, "c");
        assert_eq!(c.edges.len(), 1);
        assert_eq!(c.edges[0].from_lane, 0);
        assert_eq!(c.edges[0].to_lane, 0);
        assert_eq!(c.edges[0].to_row, 1);
    }

    #[test]
    fn fork_uses_a_second_lane() {
        //   d   (feature tip, parent b)
        //   | c (main tip, parent b)
        //   |/
        //   b
        //   a
        // Walk order newest-first: d, c, b, a
        let r = assign_lanes(vec![
            node("d", &["b"]),
            node("c", &["b"]),
            node("b", &["a"]),
            node("a", &[]),
        ]);
        // d and c are independent tips → distinct lanes.
        assert_ne!(by_oid(&r, "d").lane, by_oid(&r, "c").lane);
        // They converge on b: both have an edge whose endpoint is b's row.
        let b_row = by_oid(&r, "b").row;
        for tip in ["d", "c"] {
            let p = by_oid(&r, tip);
            assert_eq!(p.edges.len(), 1);
            assert_eq!(p.edges[0].to_row, b_row);
            assert_eq!(p.edges[0].to_lane, by_oid(&r, "b").lane);
        }
    }

    #[test]
    fn merge_commit_has_two_parent_edges() {
        //   m   merge of b (first) and c (second)
        //  / \
        // b   c
        //  \ /
        //   a
        // Walk order: m, b, c, a
        let r = assign_lanes(vec![
            node("m", &["b", "c"]),
            node("b", &["a"]),
            node("c", &["a"]),
            node("a", &[]),
        ]);
        let m = by_oid(&r, "m");
        assert_eq!(m.edges.len(), 2, "merge has one edge per parent");
        // First-parent edge stays in the merge's own lane.
        assert_eq!(m.edges[0].from_lane, m.lane);
        assert_eq!(m.edges[0].to_lane, by_oid(&r, "b").lane);
        // Second parent routes to a different lane.
        assert_eq!(m.edges[1].to_lane, by_oid(&r, "c").lane);
        assert_ne!(by_oid(&r, "b").lane, by_oid(&r, "c").lane);
    }

    #[test]
    fn parent_outside_window_keeps_default_edge_row() {
        // Single commit whose parent was truncated by a limit: the parent id is
        // synthetic (>= n) so the edge keeps to_row = 0 and never panics.
        let r = assign_lanes(vec![node("x", &["missing"])]);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].edges.len(), 1);
        assert_eq!(r[0].edges[0].to_row, 0);
    }
}

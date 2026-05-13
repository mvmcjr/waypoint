use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct CommitNode {
    pub oid: String,
    pub parent_oids: Vec<String>,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub refs: Vec<String>,
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
/// OID) so subsequent commits cannot reuse that slot.  When the parent is
/// eventually processed it clears all routing duplicates of its OID and
/// collapses back to its canonical lane.  This gives every independent
/// branch its own dedicated X-axis column.
pub fn assign_lanes(commits: Vec<CommitNode>) -> Vec<PositionedCommit> {
    // lane index → OID that currently owns the slot (None = free).
    let mut lanes: Vec<Option<String>> = Vec::new();
    // OID → color index so first-parent chains share a color.
    let mut oid_color: HashMap<String, usize> = HashMap::new();
    let mut next_color: usize = 0;
    // OID → row index; filled as we go; used in the second pass.
    let mut oid_to_row: HashMap<String, usize> = HashMap::new();

    let mut result: Vec<PositionedCommit> = Vec::new();

    for (row, commit) in commits.iter().enumerate() {
        oid_to_row.insert(commit.oid.clone(), row);

        // ── 1. Find this commit's canonical lane ─────────────────────────
        // A child commit may have pre-allocated our lane; if not, take the
        // first free slot or grow the array.
        let commit_lane = lanes
            .iter()
            .position(|s| s.as_deref() == Some(commit.oid.as_str()))
            .unwrap_or_else(|| {
                if let Some(free) = lanes.iter().position(|s| s.is_none()) {
                    free
                } else {
                    lanes.push(None);
                    lanes.len() - 1
                }
            });

        if commit_lane >= lanes.len() {
            lanes.resize(commit_lane + 1, None);
        }
        lanes[commit_lane] = Some(commit.oid.clone());

        // ── 2. Clear routing duplicates ───────────────────────────────────
        // Child commits may have left extra copies of our OID in other lane
        // slots to hold those routes open.  Now that we're here, collapse
        // everything back to commit_lane.
        for i in 0..lanes.len() {
            if i != commit_lane && lanes[i].as_deref() == Some(commit.oid.as_str()) {
                lanes[i] = None;
            }
        }

        // ── 3. Assign color ───────────────────────────────────────────────
        let color_idx = *oid_color.entry(commit.oid.clone()).or_insert_with(|| {
            let c = next_color % 8;
            next_color += 1;
            c
        });

        // ── 4. Allocate lanes for each parent ─────────────────────────────
        // commit_lane is still occupied here (not freed yet) so second/third
        // parents won't accidentally reuse it.
        let mut edges: Vec<GraphEdge> = Vec::new();

        for (i, parent_oid) in commit.parent_oids.iter().enumerate() {
            let target_lane =
                if let Some(existing) = lanes.iter().position(|s| s.as_deref() == Some(parent_oid.as_str())) {
                    // Parent already has a lane (pre-allocated by another child).
                    existing
                } else if i == 0 {
                    // First parent inherits this commit's lane.
                    commit_lane
                } else {
                    // Merge parent: find a free slot or grow.
                    if let Some(free) = lanes.iter().position(|s| s.is_none()) {
                        free
                    } else {
                        lanes.push(None);
                        lanes.len() - 1
                    }
                };

            if target_lane >= lanes.len() {
                lanes.resize(target_lane + 1, None);
            }
            // Claim the slot for this parent (may overwrite commit's own OID
            // when target_lane == commit_lane — that is intentional).
            lanes[target_lane] = Some(parent_oid.clone());

            // Color: first parent inherits commit's color; others get a new one.
            // For the first-parent claim we take MIN(existing, current) so that
            // a "main-ier" chain (lower color_idx, claimed earlier in the walk)
            // wins out over a side branch that happened to reach this parent
            // first. Without this, e.g. a renovate branch processed before the
            // trunk would stamp the trunk's lane its own color from the
            // convergence point downward.
            let edge_color = if i == 0 {
                let entry = oid_color.entry(parent_oid.clone()).or_insert(color_idx);
                if color_idx < *entry {
                    *entry = color_idx;
                }
                color_idx
            } else {
                *oid_color.entry(parent_oid.clone()).or_insert_with(|| {
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
        // pre-allocated elsewhere), commit_lane is still holding commit's OID.
        // Replace it with the first parent's OID so the lane slot stays
        // occupied — preventing other commits from reusing it — until the
        // parent is actually processed and clears it in step 2 above.
        if let Some(first_parent) = commit.parent_oids.first() {
            if lanes[commit_lane].as_deref() == Some(commit.oid.as_str()) {
                // First parent did NOT inherit commit_lane → need routing.
                lanes[commit_lane] = Some(first_parent.clone());
            }
            // Else: first parent already wrote its OID into commit_lane → done.
        } else {
            // Root commit (no parents): free the lane.
            lanes[commit_lane] = None;
        }

        result.push(PositionedCommit {
            commit: commit.clone(),
            lane: commit_lane,
            row,
            color_idx,
            edges,
        });
    }

    // ── Second pass: fill in to_row + to_lane for every edge ──────────────
    // edges[i] corresponds to commit.parent_oids[i] (same iteration order).
    //
    // to_lane is rewritten here because the lane recorded during step 4 was
    // whichever slot the parent was preallocated in at the time — but step 2,
    // when the parent itself is processed later, collapses all routing
    // duplicates back to the parent's first occurrence. The parent dot ends up
    // at that first-occurrence lane, so the edge endpoint has to match.
    let oid_to_lane: HashMap<String, usize> = result
        .iter()
        .map(|p| (p.commit.oid.clone(), p.lane))
        .collect();
    for item in result.iter_mut() {
        for (edge_idx, edge) in item.edges.iter_mut().enumerate() {
            if let Some(parent_oid) = item.commit.parent_oids.get(edge_idx) {
                if let Some(&pr) = oid_to_row.get(parent_oid) {
                    edge.to_row = pr;
                }
                if let Some(&pl) = oid_to_lane.get(parent_oid) {
                    edge.to_lane = pl;
                }
            }
        }
    }

    result
}

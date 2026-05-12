use serde::Serialize;

/// Raw commit data before lane assignment.
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

/// An edge drawn between rows in the graph.
#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from_lane: usize,
    pub to_lane: usize,
    pub from_row: usize,
    pub to_row: usize,
}

/// A commit with its lane position and derived edges.
#[derive(Debug, Clone, Serialize)]
pub struct PositionedCommit {
    pub commit: CommitNode,
    pub lane: usize,
    pub row: usize,
    pub color_idx: usize,
    /// Lanes that pass through this row without stopping (continuations).
    pub active_lanes: Vec<Option<String>>,
    /// Edges starting at this row going upward to parent rows.
    pub edges: Vec<GraphEdge>,
}

/// Assign lanes to a topologically-sorted list of commits.
///
/// `commits` must be in reverse-chronological (newest-first) order,
/// as returned by `git2::Revwalk`.
pub fn assign_lanes(commits: Vec<CommitNode>) -> Vec<PositionedCommit> {
    // lane slot -> oid that "owns" the slot (None = free)
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut result: Vec<PositionedCommit> = Vec::new();

    // oid -> row index, built as we go
    let mut oid_to_row: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for (row, commit) in commits.iter().enumerate() {
        oid_to_row.insert(commit.oid.clone(), row);

        // Find or allocate the lane for this commit.
        let commit_lane = lanes
            .iter()
            .position(|slot| slot.as_deref() == Some(&commit.oid))
            .unwrap_or_else(|| {
                // No pre-allocated slot — take the first free one or grow.
                if let Some(free) = lanes.iter().position(|s| s.is_none()) {
                    free
                } else {
                    lanes.push(None);
                    lanes.len() - 1
                }
            });

        // Claim this slot.
        lanes[commit_lane] = Some(commit.oid.clone());

        // Snapshot active lanes for this row (before we free the current slot).
        let active_snapshot = lanes.clone();

        // Free the current lane slot after we've captured the snapshot.
        lanes[commit_lane] = None;

        // Assign lanes to parents: first parent continues in the same lane,
        // additional parents get new slots.
        let mut edges: Vec<GraphEdge> = Vec::new();

        for (i, parent_oid) in commit.parent_oids.iter().enumerate() {
            let target_lane = if i == 0 {
                // First parent inherits this commit's lane.
                commit_lane
            } else {
                // Merge parent: pick a free lane or grow.
                if let Some(free) = lanes.iter().position(|s| s.is_none()) {
                    free
                } else {
                    lanes.push(None);
                    lanes.len() - 1
                }
            };

            // Only pre-allocate if no other commit already claimed this slot.
            if lanes.get(target_lane).map_or(true, |s| s.is_none()) {
                if target_lane >= lanes.len() {
                    lanes.resize(target_lane + 1, None);
                }
                lanes[target_lane] = Some(parent_oid.clone());
            }

            // We'll fill in `to_row` once we know the parent's row — set 0 as placeholder.
            edges.push(GraphEdge {
                from_lane: commit_lane,
                to_lane: target_lane,
                from_row: row,
                to_row: 0,
            });
        }

        let color_idx = commit_lane % 8;

        result.push(PositionedCommit {
            commit: commit.clone(),
            lane: commit_lane,
            row,
            color_idx,
            active_lanes: active_snapshot,
            edges,
        });
    }

    // Second pass: fill in `to_row` for each edge using the oid->row map.
    for item_idx in 0..result.len() {
        let n_edges = result[item_idx].edges.len();
        for edge_idx in 0..n_edges {
            let parent_oid = result[item_idx].commit.parent_oids.get(edge_idx).cloned();
            if let Some(oid) = parent_oid {
                if let Some(&pr) = oid_to_row.get(&oid) {
                    result[item_idx].edges[edge_idx].to_row = pr;
                }
            }
        }
    }

    result
}

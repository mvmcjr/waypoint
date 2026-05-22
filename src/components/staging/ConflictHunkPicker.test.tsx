import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConflictHunkPicker } from "./ConflictHunkPicker";
import { ipc } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getConflictContent: vi.fn(),
    resolveWithContent: vi.fn(),
  },
}));

const mockConflictContent = `console.log("hello");
<<<<<<< HEAD
const mode = "ours";
console.log("doing ours");
=======
const mode = "theirs";
console.log("doing theirs");
>>>>>>> feature-branch
console.log("world");`;

describe("ConflictHunkPicker", () => {
  const mockOnResolved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads and renders conflict hunks in stacked view mode by default", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="stacked"
        onResolved={mockOnResolved}
      />
    );

    // Should display loader initially
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();

    // Wait for the hunk details to be loaded and displayed
    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // Check that both branches labels are rendered
    expect(screen.getByText("← HEAD")).toBeInTheDocument();
    expect(screen.getByText("→ feature-branch")).toBeInTheDocument();

    // Check lines of code are rendered
    expect(screen.getByText("const mode = \"ours\";")).toBeInTheDocument();
    expect(screen.getByText("const mode = \"theirs\";")).toBeInTheDocument();
  });

  it("renders side-by-side view mode when specified", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="side-by-side"
        onResolved={mockOnResolved}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // In side-by-side, we should also see the "Result" header in the right column
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("Click ○ lines to include…")).toBeInTheDocument();
  });

  it("handles whole hunk picker choices: Ours", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);
    vi.mocked(ipc.resolveWithContent).mockResolvedValue(undefined);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="stacked"
        onResolved={mockOnResolved}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // Click "Ours" button
    const oursBtn = screen.getByRole("button", { name: "Ours" });
    fireEvent.click(oursBtn);

    // Expect resolveWithContent to be called automatically because all hunks are resolved
    await waitFor(() => {
      expect(ipc.resolveWithContent).toHaveBeenCalledWith(
        "repo1",
        "src/index.js",
        `console.log("hello");
const mode = "ours";
console.log("doing ours");
console.log("world");`
      );
    });

    expect(mockOnResolved).toHaveBeenCalled();
  });

  it("handles whole hunk picker choices: Theirs", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);
    vi.mocked(ipc.resolveWithContent).mockResolvedValue(undefined);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="stacked"
        onResolved={mockOnResolved}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // Click "Theirs" button
    const theirsBtn = screen.getByRole("button", { name: "Theirs" });
    fireEvent.click(theirsBtn);

    await waitFor(() => {
      expect(ipc.resolveWithContent).toHaveBeenCalledWith(
        "repo1",
        "src/index.js",
        `console.log("hello");
const mode = "theirs";
console.log("doing theirs");
console.log("world");`
      );
    });

    expect(mockOnResolved).toHaveBeenCalled();
  });

  it("handles whole hunk picker choices: Both", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);
    vi.mocked(ipc.resolveWithContent).mockResolvedValue(undefined);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="stacked"
        onResolved={mockOnResolved}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // Click "Both" button
    const bothBtn = screen.getByRole("button", { name: "Both" });
    fireEvent.click(bothBtn);

    await waitFor(() => {
      expect(ipc.resolveWithContent).toHaveBeenCalledWith(
        "repo1",
        "src/index.js",
        `console.log("hello");
const mode = "ours";
console.log("doing ours");
const mode = "theirs";
console.log("doing theirs");
console.log("world");`
      );
    });

    expect(mockOnResolved).toHaveBeenCalled();
  });

  it("handles custom line-level picking and displays Result live", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);
    vi.mocked(ipc.resolveWithContent).mockResolvedValue(undefined);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="side-by-side"
        onResolved={mockOnResolved}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // Toggle specific line on, e.g., first line of "ours" side
    const lineOurs = screen.getByText("const mode = \"ours\";");
    fireEvent.click(lineOurs);

    // Now, let's toggle the second line of "theirs" side
    const lineTheirs = screen.getByText("console.log(\"doing theirs\");");
    fireEvent.click(lineTheirs);

    // Click "Accept Selection" button to finalize
    const acceptBtn = screen.getByRole("button", { name: "Accept Selection" });
    fireEvent.click(acceptBtn);

    // It should trigger a merge resolving with only the selected custom lines!
    await waitFor(() => {
      expect(ipc.resolveWithContent).toHaveBeenCalledWith(
        "repo1",
        "src/index.js",
        `console.log("hello");
const mode = "ours";
console.log("doing theirs");
console.log("world");`
      );
    });

    expect(mockOnResolved).toHaveBeenCalled();
  });

  it("allows toggling full-file Result Preview tab", async () => {
    vi.mocked(ipc.getConflictContent).mockResolvedValue(mockConflictContent);

    render(
      <ConflictHunkPicker
        repoId="repo1"
        path="src/index.js"
        viewMode="stacked"
        onResolved={mockOnResolved}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Conflict 1 of 1")).toBeInTheDocument();
    });

    // Initially on "Conflicts" tab
    expect(screen.queryByText(/⚠ Conflict 1 — not yet resolved/i)).not.toBeInTheDocument();

    // Click the "Result Preview" tab
    const resultTabBtn = screen.getByRole("button", { name: "Result Preview" });
    fireEvent.click(resultTabBtn);

    // Result file preview should display warnings for unresolved conflicts and original context lines
    expect(screen.getByText("⚠ Conflict 1 — not yet resolved")).toBeInTheDocument();
    expect(screen.getByText("console.log(\"hello\");")).toBeInTheDocument();
    expect(screen.getByText("console.log(\"world\");")).toBeInTheDocument();
  });
});

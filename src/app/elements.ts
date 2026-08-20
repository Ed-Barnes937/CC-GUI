// The static chrome from index.html, resolved once.
//
// Every element here is markup the app never removes, so the non-null
// assertions hold for the life of the window. Views import the handles they
// need instead of each re-querying, which keeps the selectors that couple
// TypeScript to index.html in one place.

// ------------------------------------------------------------------ sidebar
export const sessionsEl = document.querySelector<HTMLDivElement>("#sessions")!;

// ---------------------------------------------------------------- terminals
export const tabsEl = document.querySelector<HTMLDivElement>("#tabs")!;
export const terminalsEl = document.querySelector<HTMLDivElement>("#terminals")!;
export const placeholderEl = document.querySelector<HTMLDivElement>("#placeholder")!;

// ------------------------------------------------------------- detail panel
export const detailEl = document.querySelector<HTMLElement>("#detail")!;
export const detailTitleEl = document.querySelector<HTMLSpanElement>("#detail-title")!;
export const detailMetaEl = document.querySelector<HTMLDListElement>("#detail-meta")!;
export const detailChangesEl = document.querySelector<HTMLDivElement>("#detail-changes-label")!;
export const detailDiffstatEl = document.querySelector<HTMLDivElement>("#detail-diffstat")!;
export const detailSummaryEl = document.querySelector<HTMLDivElement>("#detail-summary")!;
export const detailTagsEl = document.querySelector<HTMLDivElement>("#detail-tags")!;
export const summaryGenEl = document.querySelector<HTMLButtonElement>("#summary-gen")!;
export const detailReviewEl = document.querySelector<HTMLButtonElement>("#detail-review")!;
export const detailPrEl = document.querySelector<HTMLButtonElement>("#detail-pr")!;

// --------------------------------------------------------------- onboarding
export const onboardingEl = document.querySelector<HTMLDivElement>("#onboarding")!;
export const onboardingAddProjectBtn = document.querySelector<HTMLButtonElement>("#onboarding-add-project")!;
export const onboardingCommanderBtn = document.querySelector<HTMLButtonElement>("#onboarding-commander")!;

// ---------------------------------------------------------- shell / titlebar
export const appEl = document.querySelector<HTMLElement>("#app")!;
export const tbCount = document.querySelector<HTMLElement>("#tb-count")!;
export const tbAttention = document.querySelector<HTMLElement>("#tb-attention")!;
export const tbConsole = document.querySelector<HTMLButtonElement>("#tb-console")!;
export const tbBoard = document.querySelector<HTMLButtonElement>("#tb-board")!;
export const commanderChip = document.querySelector<HTMLElement>("#commander-chip")!;

// -------------------------------------------------------------------- board
export const boardEl = document.querySelector<HTMLElement>("#board")!;
export const boardFilterEl = document.querySelector<HTMLDivElement>("#board-filter")!;
export const boardColumnsEl = document.querySelector<HTMLDivElement>("#board-columns")!;
export const boardDockEl = document.querySelector<HTMLDivElement>("#board-dock")!;
export const boardDockSurfaceEl = document.querySelector<HTMLDivElement>("#board-dock-surface")!;
export const boardDockPlaceholderEl = document.querySelector<HTMLDivElement>("#board-dock-placeholder")!;
export const boardDockNameEl = document.querySelector<HTMLSpanElement>("#board-dock-name")!;
export const boardDockBranchEl = document.querySelector<HTMLSpanElement>("#board-dock-branch")!;
export const boardDockBackdropEl = document.querySelector<HTMLDivElement>("#board-dock-backdrop")!;

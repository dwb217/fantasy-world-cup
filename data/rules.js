// Scoring rules — these are applied to every owned national team, per match.
// The labels here are used both for display and by the scoring engine.
window.RULES = {
  win:        { points: 6, label: "Win" },
  draw:       { points: 2, label: "Draw (group stage only)" },
  cleanSheet: { points: 1, label: "Clean sheet" },
  twoGoals:   { points: 1, label: "Scored 2+ goals" },
  fourGoals:  { points: 1, label: "Scored 4+ goals" },
  winByTwo:   { points: 1, label: "Won by 2+ goals" },
  extraTime:  { points: 1, label: "Reached extra time (knockout)" },
  penalties:  { points: 1, label: "Reached penalties (knockout)" },
};

// Knockout rule: there are NO draws in the knockout round. The team that
// advances (higher score, or the shootout winner if level after extra time)
// gets the Win points; the other team gets 0 for the win/draw category.

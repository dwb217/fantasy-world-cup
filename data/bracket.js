// Single source of truth for the official 2026 World Cup bracket STRUCTURE: the
// group draw (team → group letter), FIFA's Round-of-32 template, the third-place
// slot eligibility, and the fixed R16→Final tree. The projections build
// (scripts/build_projections.js) reads this so it follows the SAME deterministic
// bracket the What-If tab walks, instead of randomly re-pairing survivors.
//
// (app.js still keeps its own identical copy inline; this template is immutable —
// it's the real tournament structure — so the two cannot meaningfully drift.)
//
// A spec in `r32` is ["p1",L] (group L winner), ["p2",L] (runner-up), or
// ["3",slot] (a best-third placed in that R32 third-slot). Entries in r16/qf/sf
// are [winnerSlot, feederX, feederY]; `final`/`third` are [slot, feederX,
// feederY] (third = the two semi-final LOSERS).
window.BRACKET = {
  group: {
    Mexico:"A", "South Africa":"A", "South Korea":"A", Czechia:"A",
    Canada:"B", "Bosnia & Herz":"B", Qatar:"B", Switzerland:"B",
    Brazil:"C", Morocco:"C", Haiti:"C", Scotland:"C",
    USA:"D", Paraguay:"D", Australia:"D", Turkey:"D",
    Germany:"E", Curacao:"E", "Ivory Coast":"E", Ecuador:"E",
    Netherlands:"F", Japan:"F", Sweden:"F", Tunisia:"F",
    Belgium:"G", Egypt:"G", Iran:"G", "New Zealand":"G",
    Spain:"H", "Cape Verde":"H", "Saudi Arabia":"H", Uruguay:"H",
    France:"I", Senegal:"I", Iraq:"I", Norway:"I",
    Argentina:"J", Algeria:"J", Austria:"J", Jordan:"J",
    Portugal:"K", "DR Congo":"K", Uzbekistan:"K", Colombia:"K",
    England:"L", Croatia:"L", Ghana:"L", Panama:"L",
  },
  thirdSlots: {
    M74:["A","B","C","D","F"], M77:["C","D","F","G","H"], M79:["C","E","F","H","I"],
    M80:["E","H","I","J","K"], M81:["B","E","F","I","J"], M82:["A","E","H","I","J"],
    M85:["E","F","G","I","J"], M87:["D","E","I","J","L"],
  },
  r32: [
    [73, ["p2","A"], ["p2","B"]], [74, ["p1","E"], ["3","M74"]], [75, ["p1","F"], ["p2","C"]], [76, ["p1","C"], ["p2","F"]],
    [77, ["p1","I"], ["3","M77"]], [78, ["p2","E"], ["p2","I"]], [79, ["p1","A"], ["3","M79"]], [80, ["p1","L"], ["3","M80"]],
    [81, ["p1","D"], ["3","M81"]], [82, ["p1","G"], ["3","M82"]], [83, ["p2","K"], ["p2","L"]], [84, ["p1","H"], ["p2","J"]],
    [85, ["p1","B"], ["3","M85"]], [86, ["p1","J"], ["p2","H"]], [87, ["p1","K"], ["3","M87"]], [88, ["p2","D"], ["p2","G"]],
  ],
  r16:   [[89,74,77],[90,73,75],[91,76,78],[92,79,80],[93,83,84],[94,81,82],[95,86,88],[96,85,87]],
  qf:    [[97,89,90],[98,93,94],[99,91,92],[100,95,96]],
  sf:    [[101,97,98],[102,99,100]],
  final: [104,101,102],
  third: [103,101,102],
};

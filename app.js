//set up the canvas element. the const canvas is the drawing area and ctx holds all the info of a given drawing, in this case all the truss and force diagram info
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
//this handles canvas resizing for zooming and diff screens so canvas doesn't break. pixelratio ranges from 1-3 and width/height handled later in updateview function
let pixelRatio = 1;
let canvaswidth = 0,
  canvasheight = 0;
let viewInitialised = false;

// state is the main "box" holding all the information of a given user's truss, loads, reactions, forces in each member, etc
// nodes array to store the node info, members array to store member info, supports array for supports info, loads array for loads info, Young's modulus and cross sec area global vals
let state = {
  nodes: [], //{(x,y)}
  members: [], //{(a,b)}

  supports: [], // {node, type}  type as in pin, rollH, rollV
  loads: [], // {node, fx, fy}
  E: 200000, // global
  A: 1, // global
  result: null, // filled by Solve, cleared by any edit
  lastSolve: null, // entire solver output with the matrices for the show your work section
};

//main UI inits, mode is when you click the toolbar and select to add nodes, members, forces, etc
//nextMember is for when you are making a member using 2 nodes and need to store the first node while waiting for the second node
//drag is for when you pan vs click and do nothing
let mode = "node";
let nextMember = null;
let drag = null;

//view is an object having the pan/scale properties like zoom/scale for entire graph and then location (x,y) of 0,0 as you pan. scale is in units of pixels per 1m. so scale 40 is 40 pixels per 1m
let view = { scale: 40, originx: 0, originy: 0 };
//solver requires two coordinate systems. an onscreen coordinates in pixels measured from topleft of canvas element and real world coordinates in meters measured from 0,0. need functions
//  that will convert between the two ALSO based on the canvas  scale and offset of 0,0 onscreen, so this uses view object
function screenToRealCoords(px, py) {
  // (pixels - pixel offset)/scale gets you the real world dimensions. so aiming the mouse 40px left of 0,0 when 0,0 is center of screen would mean -1m in real units. negative on y because
  // y is down in canvas and up in real world
  return [(px - view.originx) / view.scale, (view.originy - py) / view.scale];
}
function realToScreenCoords(x, y) {
  // real world dim divided by scale gives you pixels, then add the offset to get adjusted pixels
  return [view.originx + x * view.scale, view.originy - y * view.scale];
}

let tolerance = 1e-6; //if a distance is less than a micron by floating pt math it's functionally 0
//main rounder function for many displayed values in the matrices, table,s and chart numbers. default is like 1.000 but can round to any digits. if less than a micron, = 0 (for matrix/LU)
function rounder(v, decimalpts) {
  if (decimalpts == undefined) {
    decimalpts = 3;
  }
  if (Math.abs(v) < tolerance) {
    return "0";
  } else {
    return v.toFixed(decimalpts);
  }
}

//drawing tools!

//grid paper spacing array generator. need proper spacings with defined dimensions between the pixeled lines at every zoom level, so take some common ranges and try to fit 24px gaps in there
function createSpacings() {
  let spacings = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]; //some common spacing in meters you might find in a truss
  for (let i = 0; i < spacings.length; i++) {
    let s = spacings[i];
    //depending on the scale, the first possible # of meters in spacing that makes grid lines which are 24px apart or bigger is chosen
    if (s * view.scale >= 24) {
      return s;
    }
  }

  return 1000; //fallback 1000m
}

//actual generation of gridlines on the canvas
//canvas ctx works like this:
// step 1: set ctx properties linewidth strokeStyle
// step 2: call beginPath to start describing the stuff to draw
// step 3: use moveto and lineto for commands
// step 4: when done say ctx.stroke and that ends the entire block and lets you redefine again
function drawGrid() {
  const spacing = createSpacings();
  const [x0, y1] = screenToRealCoords(0, 0);
  const [x1, y0] = screenToRealCoords(canvaswidth, canvasheight);
  //lot of borrowed code from mozilla and w3schools
  //MINOR LINES
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(80,130,190,0.25)";
  ctx.beginPath();
  for (let x = Math.ceil(x0 / spacing) * spacing; x <= x1; x += spacing) {
    const sx = Math.round(realToScreenCoords(x, 0)[0]) + 0.5;
    //essentially move the pointer to the top of the screen at the designated x spacing and then draw a line to the bottom of the screen at said x value
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, canvasheight);
  }
  for (let y = Math.ceil(y0 / spacing) * spacing; y <= y1; y += spacing) {
    //same for the horiz lines
    const sy = Math.round(realToScreenCoords(0, y)[1]) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(canvaswidth, sy);
  }
  ctx.stroke();
  //MAJOR (AXIS) LINES
  const [ax, ay] = realToScreenCoords(0, 0);
  ctx.strokeStyle = "rgba(40,90,160,0.55)";
  ctx.beginPath();
  ctx.moveTo(Math.round(ax) + 0.5, 0);
  ctx.lineTo(Math.round(ax) + 0.5, canvasheight);
  ctx.moveTo(0, Math.round(ay) + 0.5);
  ctx.lineTo(canvaswidth, Math.round(ay) + 0.5);
  ctx.stroke();
}

//to draw the arrow, fill in (and fill over) the line going from x0,y0 to x1,y1 with a thicker line and then draw an arrow of width 9 and offset 0.4radians (pitch of back arrows) at the end
function drawArrow(x0, y0, x1, y1, color) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  //thick fill-in line
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  //draw the arrowhead
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 9 * Math.cos(angle - 0.4), y1 - 9 * Math.sin(angle - 0.4));
  ctx.lineTo(x1 - 9 * Math.cos(angle + 0.4), y1 - 9 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

//on the results canvas, every member needs a small box with the force display on top of the previous arrows
function drawLabel(text, centerx, centery, color) {
  ctx.font = '12px "Segoe UI", sans-serif';
  //measuretext grabs how wide a canvas text's box will be
  const width = ctx.measureText(text).width + 8;
  const height = 16;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  let startx = centerx - width / 2;
  let starty = centery - height / 2;
  ctx.fillRect(startx, starty, width, height);
  ctx.strokeRect(startx + 0.5, starty + 0.5, width, height);

  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, centerx, centery + 0.5);
}

//neat ctx code for drawing supports using many lines and some circles
function drawSupport(sx, sy, type) {
  //save and restore keep a pre-support state of the canvas and holds these changes in limbo until restore() to not stain the current drawing
  ctx.save();
  ctx.translate(sx, sy);
  if (type === "rollV") ctx.rotate(Math.PI / 2);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-12, 20);
  ctx.lineTo(12, 20);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (type === "pin") {
    ctx.beginPath();
    ctx.moveTo(-18, 20);
    ctx.lineTo(18, 20);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -16; x <= 12; x += 7) {
      ctx.moveTo(x + 6, 20);
      ctx.lineTo(x, 27);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-2, 24);
    ctx.arc(-6, 24, 4, 0, Math.PI * 2);
    ctx.moveTo(10, 24);
    ctx.arc(6, 24, 4, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-18, 28);
    ctx.lineTo(18, 28);
    ctx.stroke();
  }
  ctx.restore();
}

function forceColor(force) {
  //returns the right graph color based on a member's internal force
  if (Math.abs(force) < tolerance) {
    return "#555";
  } else if (force > 0) {
    return "blue";
  } else {
    return "red";
  }
}

//the one big function that draws a new truss every time user adds/removes elements or hits solve
//this is to make the chance of weird lagging UI bugs 0% or internal forces state not correlating to canvas drawing

function draw() {
  //settransform for scaling all drawing operations in draw by device's pixel ratio so it works on any screen
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvaswidth, canvasheight); //deletes ALL of previous drawing

  //draws the grid again
  drawGrid();

  //for loop to draw all members
  //pull all the members, grab the data of their 2 nodes, get the x and y coordinates,
  //draw the member, then if the member has a force, color it over with drawLabel, if not, make it grey
  //note members themselves have no arrows so drawarrow isn't needed
  for (let i = 0; i < state.members.length; i++) {
    let member = state.members[i];
    let node1 = state.nodes[member.a],
      node2 = state.nodes[member.b];
    let point1 = realToScreenCoords(node1.x, node1.y),
      point2 = realToScreenCoords(node2.x, node2.y);
    let x1 = point1[0];
    let y1 = point1[1];
    let x2 = point2[0];
    let y2 = point2[1];

    let f = null; //force
    if (state.result) {
      f = state.result.memberForces[i];
    }

    if (f === null) {
      ctx.strokeStyle = "#222";
    } else {
      ctx.strokeStyle = forceColor(f);
    }

    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    if (f !== null) {
      drawLabel(rounder(f, 3), (x1 + x2) / 2, (y1 + y2) / 2, forceColor(f));
    }
  }

  //for loop for drawing supports
  //traverses all supports, find their node, draws a support there
  //recall every support is stored in state as {node, type} so s.node grabs the node number the support is on
  for (let i = 0; i < state.supports.length; i++) {
    let s = state.supports[i];
    let n = state.nodes[s.node];
    let point = realToScreenCoords(n.x, n.y);
    //recall drawsupport takes in arguments for x,y and the type so it knows what kind of support to draw
    drawSupport(point[0], point[1], s.type);
  }

  //for loop for drawing the external loads
  //again traverses through the state's loads array
  for (let i = 0; i < state.loads.length; i++) {
    let l = state.loads[i];
    //recall loads are objects of {node, fx, fy} so just ask for fx and fy of every load
    let magnitude = Math.hypot(l.fx, l.fy);

    if (magnitude < tolerance) {
      continue;
    }

    let n = state.nodes[l.node];
    let point = realToScreenCoords(n.x, n.y);

    let screenx = point[0];
    let screeny = point[1];

    let extx = screenx + (l.fx / magnitude) * 46; //46 is the length in pixels of the rxn arrows
    let exty = screeny - (l.fy / magnitude) * 46;

    drawArrow(screenx, screeny, extx, exty, "#111");
  }

  //draw reactions AFTER a successful solve, same principle as the loads arrows but rxns are green
  if (state.result) {
    for (let i = 0; i < state.result.reactions.length; i++) {
      let r = state.result.reactions[i];
      let mag = Math.hypot(r.fx, r.fy);

      if (mag < tolerance) {
        continue;
      }

      let n = state.nodes[r.node];
      let point = realToScreenCoords(n.x, n.y);

      let sx = point[0];
      let sy = point[1];

      let ex = sx + (r.fx / mag) * 46;
      let ey = sy - (r.fy / mag) * 46;

      drawArrow(sx, sy, ex, ey, "#1b8a3f", 3);
    }
  }

  //draw nodes
  for (let i = 0; i < state.nodes.length; i++) {
    let n = state.nodes[i];
    let point = realToScreenCoords(n.x, n.y);

    let sx = point[0];
    let sy = point[1];

    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI * 2);

    if (i === nextMember) {
      ctx.fillStyle = "#ffe28a"; //if you make a member and click on a node it turns yellow as it waits
    } else {
      ctx.fillStyle = "#fff";
    }

    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#222";
    ctx.stroke();

    ctx.fillStyle = "#111";
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(i, sx, sy + 0.5);
  }

  //so at the end of drawtruss(), all the for loops have finished drawing in order:
  //grid, members and their forces, supports, ext forces, reaction forces, and nodes
}

//code for editing the truss model (adding/removing nodes, members, forces, supports, etc)

function invalidate() {
  //gets rid of solved results info and resets "ready to solve" status message
  state.result = null;
  state.lastSolve = null;
  renderWorking(); //working as in the how it's done page. calling renderworking in the invalidate() means rendering nothing, which will collapse the panel
  document.getElementById("message").textContent = "";
  document.getElementById("message").className = "status";
}

function addNode(x, y) {
  //runs through entire state.nodes array and sees if a node already exists at that spot (x,y)
  for (let i = 0; i < state.nodes.length; i++) {
    //state.node.length = length of nodes=[]
    let n = state.nodes[i];

    let dx = n.x - x;
    let dy = n.y - y;
    let distance = Math.hypot(dx, dy);

    if (distance < tolerance) {
      return; //if there IS a node there do nothing
    }
  }

  //if there isn't a node there add a node object to nodes array with info {x, y}
  state.nodes.push({ x: x, y: y });

  //update app
  invalidate();
  refresh();
}

function addMember(nodeA, nodeB) {
  if (nodeA === nodeB) {
    return; //can't draw a member as clicking the same node twice
  }
  for (let i = 0; i < state.members.length; i++) {
    //state.node.length = length of nodes=[]
    let m = state.members[i];

    if (m.a === nodeA && m.b === nodeB) {
      return;
    }
    if (m.a === nodeB && m.b === nodeA) {
      return;
    }
  }
  state.members.push({ a: nodeA, b: nodeB });
  invalidate();
  refresh();
}

function deleteNode(k) {
  //remove node at index k
  state.nodes.splice(k, 1);

  //remove members connected to deleted node, collates surviving ones in remainingMembers to rebuild
  let remainingMembers = [];

  for (let i = 0; i < state.members.length; i++) {
    let m = state.members[i];

    if (m.a !== k && m.b !== k) {
      remainingMembers.push(m);
    }
  }

  state.members = remainingMembers;

  //remove supports attached to deleted node
  let remainingSupports = [];

  for (let i = 0; i < state.supports.length; i++) {
    let s = state.supports[i];

    if (s.node !== k) {
      remainingSupports.push(s);
    }
  }

  state.supports = remainingSupports;

  //remove loads applied to deleted node
  let remainingLoads = [];

  for (let i = 0; i < state.loads.length; i++) {
    let l = state.loads[i];

    if (l.node !== k) {
      remainingLoads.push(l);
    }
  }

  state.loads = remainingLoads;

  //move remaining node references down
  for (let i = 0; i < state.members.length; i++) {
    let m = state.members[i];

    if (m.a > k) {
      m.a = m.a - 1;
    }

    if (m.b > k) {
      m.b = m.b - 1;
    }
  }

  for (let i = 0; i < state.supports.length; i++) {
    let s = state.supports[i];

    if (s.node > k) {
      s.node = s.node - 1;
    }
  }

  for (let i = 0; i < state.loads.length; i++) {
    let l = state.loads[i];

    if (l.node > k) {
      l.node = l.node - 1;
    }
  }

  //cancel any unfinished member connection
  if (nextMember !== null) {
    nextMember = null;
  }

  // Update the application
  invalidate();
  refresh();
}

function deleteMember(p) {
  state.members.splice(p, 1);
  invalidate();
  refresh();
}

function changeSupport(node, type) {
  //find support attached to this node, if one exists
  let i = -1;

  for (let j = 0; j < state.supports.length; j++) {
    if (state.supports[j].node === node) {
      i = j;
      break;
    }
  }

  //if the same support type already exists, remove it
  if (i >= 0 && state.supports[i].type === type) {
    state.supports.splice(i, 1);
  } else if (i >= 0) {
    // If a different support type exists, replace it
    state.supports[i].type = type;
  } else {
    // If no support exists, add one
    state.supports.push({ node: node, type: type });
  }
  invalidate();
  refresh();
}

function memberLength(m) {
  let P = state.nodes[m.a];
  let Q = state.nodes[m.b];
  return Math.hypot(Q.x - P.x, Q.y - P.y);
}

function hitNode(px, py) {
  let best = -1;
  let bestD = 12;
  for (let i = 0; i < state.nodes.length; i++) {
    let n = state.nodes[i];
    let point = realToScreenCoords(n.x, n.y);
    let sx = point[0];
    let sy = point[1];
    let dx = sx - px;
    let dy = sy - py;
    let distance = Math.hypot(dx, dy);
    if (distance < bestD) {
      best = i;
      bestD = distance;
    }
  }
  return best;
}

function canvasPos(e) {
  let r = canvas.getBoundingClientRect();

  let px = e.clientX - r.left;
  let py = e.clientY - r.top;

  return [px, py];
}

// Handle clicks and presses on the canvas
canvas.addEventListener("pointerdown", function (e) {
  let point = canvasPos(e);
  let px = point[0];
  let py = point[1];

  // Shift-click or middle-click pans the view
  if (e.shiftKey || e.button === 1) {
    drag = { type: "pan", x: px, y: py };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  // Only the left mouse button starts tool actions
  if (e.button !== 0) {
    return;
  }

  let clickedNode = hitNode(px, py);

  // Decide what the click does based on the selected tool
  switch (mode) {
    case "node":
      if (clickedNode < 0) {
        let point = screenToRealCoords(px, py);
        let wx = point[0];
        let wy = point[1];

        addNode(wx, wy);
      }
      break;

    case "member":
      // Clicking empty space cancels a half-finished member
      if (clickedNode < 0) {
        nextMember = null;
        draw();
        break;
      }

      // First click selects the starting node
      if (nextMember === null) {
        nextMember = clickedNode;
        draw();
      }

      // Second click completes the member
      else {
        let a = nextMember;
        nextMember = null;

        addMember(a, clickedNode);
        draw();
      }
      break;

    case "force":
      if (clickedNode < 0) {
        break;
      }

      // Check whether this node already has a load
      let hasLoad = false;

      for (let i = 0; i < state.loads.length; i++) {
        if (state.loads[i].node === clickedNode) {
          hasLoad = true;
          break;
        }
      }

      // Add a default downward load if none exists
      if (!hasLoad) {
        state.loads.push({
          node: clickedNode,
          fx: 0,
          fy: -10,
        });

        invalidate();
        refresh();
      }

      // Find this node's load in the array
      let loadIndex = -1;

      for (let i = 0; i < state.loads.length; i++) {
        if (state.loads[i].node === clickedNode) {
          loadIndex = i;
          break;
        }
      }

      // Focus the vertical force input
      let selector = '[data-load="' + loadIndex + '"][data-k="fy"]';
      let inp = document.querySelector(selector);

      if (inp) {
        setTimeout(function () {
          inp.focus();
          inp.select();
        }, 0);
      }
      break;

    case "pin":
    case "rollH":
    case "rollV":
      if (clickedNode >= 0) {
        changeSupport(clickedNode, mode);
      }
      break;

    case "move":
      // Drag a node if one was clicked; otherwise pan
      if (clickedNode >= 0) {
        drag = { type: "node", i: clickedNode };
      } else {
        drag = { type: "pan", x: px, y: py };
      }

      canvas.setPointerCapture(e.pointerId);
      break;
  }
});

canvas.addEventListener("pointermove", function (e) {
  let point = canvasPos(e);
  let px = point[0];
  let py = point[1];

  let worldPoint = screenToRealCoords(px, py);
  let wx = worldPoint[0];
  let wy = worldPoint[1];

  document.getElementById("mouse-location").textContent =
    "Mouse: (" + rounder(wx) + ", " + rounder(wy) + ") m";

  if (!drag) {
    return;
  }

  if (drag.type === "pan") {
    view.originx += px - drag.x;
    view.originy += py - drag.y;

    drag.x = px;
    drag.y = py;

    draw();
  } else if (drag.type === "node") {
    state.nodes[drag.i].x = wx;
    state.nodes[drag.i].y = wy;

    invalidate();
    refresh();
  }
});

//
canvas.addEventListener("pointerup", function () {
  drag = null;
});

//
canvas.addEventListener("pointerleave", function () {
  document.getElementById("mouse-location").textContent = "Mouse: n/a";
});

//zoom w mouse
canvas.addEventListener(
  "wheel",
  function (e) {
    e.preventDefault();

    let point = canvasPos(e);
    let px = point[0];
    let py = point[1];

    let zoomFactor;

    if (e.deltaY < 0) {
      zoomFactor = 1.1;
    } else {
      zoomFactor = 1 / 1.1;
    }

    zoomBy(zoomFactor, px, py);
  },
  { passive: false },
);

// cancel unfinished member on esc press
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    nextMember = null;
    draw();
  }
});

document.getElementById("mode-buttons").addEventListener("click", (e) => {
  let b = e.target.closest("button");
  if (!b) return;
  mode = b.dataset.mode;
  nextMember = null;
  let buttons = document.querySelectorAll("#mode-buttons button");

  for (let i = 0; i < buttons.length; i++) {
    let button = buttons[i];

    if (button === b) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  }
  draw();
});
function zoomBy(f, cx = canvaswidth / 2, cy = canvasheight / 2) {
  const [wx, wy] = screenToRealCoords(cx, cy);
  view.scale = Math.max(5, Math.min(400, view.scale * f)); //make sure zoom doesn't accidentally get too far
  view.originx = cx - wx * view.scale;
  view.originy = cy + wy * view.scale;
  draw();
}

function fitView() {
  if (!state.nodes.length) {
    view.scale = 40;
    view.originx = canvaswidth / 2;
    view.originy = canvasheight / 2;
    draw();
    return;
  }
  let xs = state.nodes.map((n) => n.x);
  let ys = state.nodes.map((n) => n.y);
  let minX = Math.min(...xs),
    maxX = Math.max(...xs);
  let minY = Math.min(...ys),
    maxY = Math.max(...ys);
  let pad = 90;

  let sx = (canvaswidth - 2 * pad) / Math.max(maxX - minX, 1);
  let sy = (canvasheight - 2 * pad) / Math.max(maxY - minY, 1);
  view.scale = Math.max(5, Math.min(120, sx, sy));
  view.originx = canvaswidth / 2 - ((minX + maxX) / 2) * view.scale;
  view.originy = canvasheight / 2 + ((minY + maxY) / 2) * view.scale;
  draw();
}

document.getElementById("fit").onclick = fitView;

document.getElementById("clear").onclick = () => {
  state.nodes = [];
  state.members = [];
  state.supports = [];
  state.loads = [];
  nextMember = null;
  invalidate();
  refresh();
  fitView();
};
document.getElementById("example").onclick = () => {
  //all these node/member locations in x,y array form get mapped to their objects in x,y form in state
  state.nodes = [
    [-4, 0],
    [-2, 0],
    [0, 0],
    [2, 0],
    [4, 0],
    [3, 3],
    [1, 3],
    [-1, 3],
    [-3, 3],
  ].map(([x, y]) => ({ x, y }));
  state.members = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [5, 6],
    [6, 7],
    [7, 8],
    [0, 8],
    [1, 8],
    [1, 7],
    [2, 7],
    [2, 6],
    [3, 6],
    [3, 5],
    [4, 5],
  ].map(([a, b]) => ({ a, b }));
  //make the objects for supports and loads too
  state.supports = [
    { node: 0, type: "pin" },
    { node: 4, type: "rollH" },
  ];
  state.loads = [
    { node: 2, fx: 0, fy: -20 },
    { node: 1, fx: 0, fy: -10 },
    { node: 3, fx: 0, fy: -10 },
  ];
  nextMember = null;
  invalidate();
  refresh();
  fitView();
};
document.getElementById("demo").onclick = () => {
  //little demo of triangle
  state.nodes = [
    [0, 0],
    [4, 0],
    [2, 2],
  ].map(([x, y]) => ({ x, y }));
  state.members = [
    [0, 1],
    [1, 2],
    [0, 2],
  ].map(([a, b]) => ({ a, b }));
  state.supports = [
    { node: 0, type: "pin" },
    { node: 1, type: "rollH" },
  ];
  state.loads = [{ node: 2, fx: 0, fy: -10 }];
  nextMember = null;
  invalidate();
  refresh();
  fitView();
};

document.getElementById("E").addEventListener("input", (e) => {
  if (parseFloat(e.target.value) > 0) {
    state.E = parseFloat(e.target.value);
    invalidate();
    refresh();
  }
});
document.getElementById("A").addEventListener("input", (e) => {
  if (parseFloat(e.target.value) > 0) {
    state.A = parseFloat(e.target.value);
    invalidate();
    refresh();
  }
});

//table functions. build answer tables dynamically from state data upon hitting solve
function buildNodeTable() {
  //state.nodes.map((n, i) converts nodes from state.nodes and makes string for each
  //table row, then makes entire array of thge strings. join makes string out of entire array
  document.getElementById("nodes-table").innerHTML = state.nodes
    .map((n, i) => {
      //all this html for a single table row tr with four cells:
      //index # of node, x coordinate, y coordinate, and delete button cell
      return `<tr>
      <td>${i}</td>
      <td>
        <input type="number" step="any" value="${n.x}" data-node="${i}" data-k="x">
      </td>
      <td>
        <input type="number" step="any" value="${n.y}" data-node="${i}" data-k="y">
      </td>
      <td>
        <button data-del-node="${i}" title="Delete node">X
        </button>
      </td>
    </tr>`;
    })
    .join("");
}
//returns the css class for a force value (tension/compression)
function forceClass(force) {
  if (Math.abs(force) < tolerance) {
    return "";
  }

  if (force > 0) {
    return "tension";
  } else {
    return "compression";
  }
}
function buildMemberTable() {
  document.getElementById("members-table").innerHTML = state.members
    .map((m, p) => {
      let r = state.result ? state.result.memberResults[p] : null; // null until solve operations
      let cls = r ? forceClass(r.force) : "";
      //table has 4 cols: index # of member, nodes attached (e.g 0-4 or 2-7),
      // member length via the memberlength function, force in member, and member stretch (delta L)
      //before user hits solve, table only reports index, nodes, and length. last two fill in after solve
      return `<tr>
      <td>${p}</td>
      <td>${m.a}-${m.b}</td>
      <td>${rounder(memberLength(m), 3)}</td>
      <td class="${cls}">${r ? rounder(r.force, 4) : ""}</td>
      <td class="${cls}">${r ? rounder(r.elongation) : ""}</td>
      <td>
        <button data-del-member="${p}" title="Delete member">X</button>
      </td>
    </tr>`;
    })
    .join("");
}
function buildLoadTable() {
  //loads or ext forces have the node they act on, x comp, y comp, and delete button
  let html = state.loads
    .map(
      (l, i) => `
    <tr>
      <td>${l.node}</td>
      <td>
        <input type="number" step="any" value="${l.fx}" data-load="${i}" data-k="fx">
      </td>
      <td>
        <input type="number" step="any" value="${l.fy}" data-load="${i}" data-k="fy">
      </td>
      <td>
        <button data-del-load="${i}" title="Remove force">X</button>
      </td>
    </tr>`,
    )
    .join("");
  //AFTER solving add support reactions to the loads table
  //each row of support reaction has the node it  acts on, x comp, y comp, NO delete button
  if (state.result) {
    html += state.result.reactions
      .map(
        (r) => `
      <tr>
        <td class="reaction">${r.node}*</td>
        <td class="reaction">${rounder(r.fx, 4)}</td>
        <td class="reaction">${rounder(r.fy, 4)}</td>
        <td></td>
      </tr>`,
      )
      .join("");
    html += '<tr><td colspan="4">*Support reactions</td></tr>';
  }
  document.getElementById("loads-table").innerHTML = html;
}

let supportNames = {
  pin: "Pin",
  rollH: "Horiz. roller",
  rollV: "Vert. roller",
};
function buildSupportTable() {
  //each support row has the node it's attached to, its type, defined above ^, and delete button
  document.getElementById("supports-table").innerHTML = state.supports
    .map(
      (s, i) => `
    <tr>
      <td>${s.node}</td>
      <td>${supportNames[s.type]}</td>
      <td>
        <button data-del-support="${i}" title="Remove support">X</button>
      </td>
    </tr>`,
    )
    .join("");
}
function readySolveCheck() {
  //checks if truss is statically determinate and gives message saying ready to solve or cannot solve
  let { errors, info } = validate(state);
  let rule = `members ${info.m} + reactions ${info.r} = ${info.unknowns} unknowns; 2 x nodes ${info.n} = ${info.equations} equations`;
  let ready = errors.length === 0;
  document.getElementById("check").textContent = ready
    ? `Ready to solve (${rule}).`
    : `${rule}.`;
  document.getElementById("check").className =
    "status " + (ready ? "ok" : "bad");
}

function refresh() {
  buildNodeTable();
  buildMemberTable();
  buildLoadTable();
  buildSupportTable();
  readySolveCheck();
  draw();
}

//now that tables are built, need functions for when you want to edit values in the tables or delete a row
//eventlistener to change values in the nodes data table. "input" woould be the user typing
document.getElementById("nodes-table").addEventListener("input", (e) => {
  let t = e.target;
  if (t.dataset.node === undefined) {
    return;
  }

  let v = parseFloat(t.value);
  if (Number.isNaN(v)) {
    return;
  }

  let nodeIndex = Number(t.dataset.node);
  let field = t.dataset.k;

  state.nodes[nodeIndex][field] = v; //assigns the new entered value to state.nodes.[index][field like x]
  //so typing in index of 1 and typing 20m in x field would do state.nodes[1][20];

  invalidate();

  buildMemberTable();
  buildLoadTable();
  readySolveCheck();
  draw();
});
document.getElementById("loads-table").addEventListener("input", function (e) {
  let t = e.target;

  if (t.dataset.load === undefined) {
    return;
  }

  let v = parseFloat(t.value);

  if (Number.isNaN(v)) {
    return;
  }

  let loadIndex = Number(t.dataset.load);
  let field = t.dataset.k;

  state.loads[loadIndex][field] = v;

  invalidate();

  buildMemberTable();
  readySolveCheck();
  draw();
});

//

document.addEventListener("click", (e) => {
  let d = e.target.dataset;
  if (!d) return;

  if (d.delNode !== undefined) {
    deleteNode(Number(d.delNode));
  } else if (d.delMember !== undefined) {
    deleteMember(Number(d.delMember));
  } else if (d.delLoad !== undefined) {
    state.loads.splice(Number(d.delLoad), 1);
    invalidate();
    refresh();
  } else if (d.delSupport !== undefined) {
    state.supports.splice(Number(d.delSupport), 1);
    invalidate();
    refresh();
  }
});

//main calculations body
//imprtant pieces: truss, DOF, K global stiffness matrix, F load vector at node x/y DOF,
//u unknown displacement vbector per node,
//Kff (K matrix of both free rows and free cols) and Ff (only free rows for F),
//uf the solved displacement at the free DOFs per node (hence uf)
//L and U factorisation matrices obtained from Kff via math.js, solves Kff*uf = Ff.

//given the supports array (recall supports: [],// {node, type}  type as in pin, rollH, rollV)
//make a plain list of individual degrees of freedom. so if we had
// supports = [
//     { node: 0, type: 'pin' },
//     { node: 2, type: 'rollH' }
// ];
//it would give each node two DOF's: node 0 has DOF 0 (x) and 1 (y), node 1 has DOF 2 (x) and 3 (y), etc
function fixedDofs(supports) {
  let list = [];
  for (let s of supports) {
    if (s.type === "pin") {
      list.push({ dof: 2 * s.node, node: s.node, axis: "x" });
      list.push({ dof: 2 * s.node + 1, node: s.node, axis: "y" });
    } else if (s.type === "rollH") {
      list.push({ dof: 2 * s.node + 1, node: s.node, axis: "y" });
    } else if (s.type === "rollV") {
      list.push({ dof: 2 * s.node, node: s.node, axis: "x" });
    }
  }
  return list;
}

//truss validator function that checks trusses for program breaking bugs or indeterminancy
function validate(truss) {
  let errors = [];
  let n = truss.nodes.length;
  let m = truss.members.length;
  let r = fixedDofs(truss.supports).length;
  let info = { n, m, r, unknowns: m + r, equations: 2 * n };

  if (n < 2) errors.push("Have at least 2 nodes");
  if (m < 1) errors.push("Have at least 1 member");
  if (truss.supports.length === 0) errors.push("Have at least 1 support");
  if (!(truss.E > 0)) errors.push("E must be positive");
  if (!(truss.A > 0)) errors.push("A must be positive");

  //checks all pairs of nodes with indexes i and j to make sure no two nodes are in
  //the same spot
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (
        Math.hypot(
          truss.nodes[i].x - truss.nodes[j].x,
          truss.nodes[i].y - truss.nodes[j].y,
        ) < tolerance
      )
        errors.push(`Nodes ${i} and ${j} cannot be at same position`);

  //checking for duplicate members, nodes with nothing attached
  let seenPairs = new Set();
  truss.members.forEach((mem, memberIndex) => {
    let key = Math.min(mem.a, mem.b) + "-" + Math.max(mem.a, mem.b);
    if (seenPairs.has(key))
      errors.push(`Member ${memberIndex} (${key}) is duplicate`);
    seenPairs.add(key);
  });
  let nodesInUse = new Set();
  truss.members.forEach((mem) => {
    nodesInUse.add(mem.a);
    nodesInUse.add(mem.b);
  });
  for (let i = 0; i < n; i++)
    if (!nodesInUse.has(i)) errors.push(`Node ${i} has no members attached`);

  //static determinacy checker based on m + r = 2n rule
  if (n >= 2 && m >= 1 && info.unknowns < info.equations)
    errors.push(
      `Unstable: ${info.unknowns} unknowns (members + reactions) but ${info.equations} equations. Add members or supports.`,
    );
  if (info.unknowns > info.equations)
    errors.push(
      `Indeterminate: ${info.unknowns} unknowns but only ${info.equations} equations. This version only solves determinate trusses. Remove members or supports.`,
    );

  return { errors, info };
}

//for matrix stiffness method, must calculate every member's length,
// unit directions (c for cos, s for sin), and the axial stiffness k0 = EA/L

function memberProperties(truss) {
  let properties = [];
  for (let i = 0; i < truss.members.length; i++) {
    let member = truss.members[i];
    let nodeA = truss.nodes[member.a];
    let nodeB = truss.nodes[member.b];

    let dx = nodeB.x - nodeA.x;
    let dy = nodeB.y - nodeA.y;
    let length = Math.hypot(dx, dy);

    let c = dx / length; //sohCAHtoa, adjacent (x) divided by hypot.
    let s = dy / length; //SOHcahtoa, y/hypot

    let k0 = (truss.E * truss.A) / length; //k = EA/L, axial stiffness and resist to stretching/shortening

    let memberInfo = {
      p: i,
      a: member.a,
      b: member.b,
      dx: dx,
      dy: dy,
      L: length,
      c: c,
      s: s,
      E: truss.E,
      A: truss.A,
      k0: k0,
    };
    properties.push(memberInfo);
  }

  return properties;
  //so now properties is an array each with all memberInfo object chock full
  //of useful data like position/index, nodes it has, dx, dy, L, c, s, E, A, and k
}

//computes transposes of only 4x4 matrices for each member in the matrix stiffness method
function transpose4x4(matrix) {
  let transpose = [];
  for (let i = 0; i < 4; i++) {
    let row = [];
    for (let j = 0; j < 4; j++) {
      row.push(matrix[j][i]); //reverses placing indices from [i][j] to [j][i]
    }
    transpose.push(row);
  }
  return transpose;
}

function matrixproduct4x4(A, B) {
  let product = [];

  //make a 4x4 of just zeros
  for (let i = 0; i < 4; i++) {
    let row = [];
    for (let j = 0; j < 4; j++) {
      row.push(0);
    }
    product.push(row);
  }
  //do A*B using the general dot product rule for each entry then push to right index
  for (let i = 0; i < 4; i++) {
    //for each row of product matrix
    for (let j = 0; j < 4; j++) {
      //then for each column
      for (let k = 0; k < 4; k++) {
        //add, four times, the coefficients to the index entry
        product[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return product;
}

//k_nought is a 4x4 stiffness matrix for each member.
//using a local coordinate system per member, you only have to ask if forces are
//parallel or perpendicular. many of these entries are 0 since I am using a local coord sys
//         u1    v1    u2    v2
// u1  [  k0     0   -k0     0 ]
// v1  [   0     0     0     0 ]
// u2  [ -k0     0    k0     0 ]
// v2  [   0     0     0     0 ]
//like this
function localElementK(k0) {
  return [
    [k0, 0, -k0, 0],
    [0, 0, 0, 0],
    [-k0, 0, k0, 0],
    [0, 0, 0, 0],
  ];
}

//for elongation, much easier to define local coordinate system for each member.
//since all truss members are two force members and only experience forces along main
//axis. define local rotation matrix using directional cosines (c and s, in place of
// dx/L, dy/L) then converts global displacements like (ax, ay, bx, by) to local
//(u1 axial, v1 transverse at node a; u2 axial, v2 transverse at node b)
//         ax    ay    bx    by
// u1  [   c,    s,    0,    0 ]
// v1  [  -s,    c,    0,    0 ]
// u2  [   0,    0,    c,    s ]
// v2  [   0,    0,   -s,    c ]
//like this
function rotationMatrixT(memberProperties) {
  let { c, s } = memberProperties;
  return [
    [c, s, 0, 0],
    [-s, c, 0, 0],
    [0, 0, c, s],
    [0, 0, -s, c],
  ];
}

//k0 (the local stiffness matrix) and T (the local to global coords matrix) multiply to
//compose the stiffness matrix k of each member in global coordinates. solver steps
//use this, not really the two intermediate products
function elementK(memberProperties) {
  //a reminder of member properties array objects
  // {
  //     p: i,
  //     a: member.a,
  //     b: member.b,
  //     dx: dx,
  //     dy: dy,
  //     L: length,
  //     c: c,
  //     s: s,
  //     E: truss.E,
  //     A: truss.A,
  //     k0: k0, axial stiffness EA/L
  //   };
  let T = rotationMatrixT(memberProperties);
  let localk = localElementK(memberProperties.k0);
  //k_global = transpose(T) * (k_local * T)
  return matrixproduct4x4(transpose4x4(T), matrixproduct4x4(localk, T));
}

//now that we have 4x4 k matrices for each member, need a global stiffness matrix K
//from adding together and augmenting all the individual k's and global force vector F

function assembleKF(truss) {
  let nodeCount = truss.nodes.length; //how many nodes do we have
  let dofCount = 2 * nodeCount; //all DOFs in the truss, every node has 2 dof.

  //start global stifffness matrix K as all zeros, square matrix of order n=dofs
  let K = [];
  for (let i = 0; i < dofCount; i++) {
    let row = [];
    for (let j = 0; j < dofCount; j++) {
      row.push(0);
    }
    K.push(row);
  }

  //start global load vector F as all zeros, column vector of length l=dofs
  let F = [];
  for (let i = 0; i < dofCount; i++) {
    F.push(0);
  }

  let allMemberPropertiesArray = memberProperties(truss);
  let mPropertiesArray = allMemberPropertiesArray;
  //cycle through all members to get k of each element (called ke) and assemble into
  //K by mapping indices of dof's
  for (let m = 0; m < mPropertiesArray.length; m++) {
    let memPropertiesObj = mPropertiesArray[m];
    let dofs = [
      2 * memPropertiesObj.a,
      2 * memPropertiesObj.a + 1,
      2 * memPropertiesObj.b,
      2 * memPropertiesObj.b + 1,
    ]; //done right, this maps, say, node 5 x,y and node 9 x,y of a member connecting
    //nodes 5 and 9 to the global stiffness matrix entries for n5x, n5y, n9x, n9y
    let ke = elementK(memPropertiesObj);

    //add ke, member stiffness, to global matrix
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        K[dofs[i]][dofs[j]] += ke[i][j]; //say 3 different members are tied to node 5
        // and all participate in the stiffness at node 5, DOF x. you have to add
        //all contributions, not replace them one after the other
      }
    }
  }

  //push all loads to F vector, F vector has rows like n0x, n0y, etc
  for (let i = 0; i < truss.loads.length; i++) {
    let load = truss.loads[i];
    F[2 * load.node] += load.fx;
    F[2 * load.node + 1] += load.fy;
  }

  //give all dofs clean labels by convention n5x, n3y. n for node, then the number, then x or y
  let dofLabels = [];

  for (let k = 0; k < nodeCount; k++) {
    dofLabels.push("n" + k + "x");
    dofLabels.push("n" + k + "y");
  }

  return {
    K: K,
    F: F,
    allMemberPropertiesArray: allMemberPropertiesArray,
    dofLabels: dofLabels,
    N: dofCount,
  };
}

// Math.js sometimes gives back js arrays and other times Math.js matrix objects. just make them all standard js arrays
function toJSArray(a) {
  if (a && typeof a.toArray === "function") {
    //mathjs lets you conv mathjs matrices to js arrays with .toArray(). toArray === 'function' sorts for mathjs matrices that have a toArray method (type comes back as 'function')
    return a.toArray();
  } else {
    return a;
  }
}

//now that we finally have big, global K and global F, can write LU factorisation and
//solving function to be used later
function LUsolve(A, b) {
  let size = A.length;

  //factor A (stiffness matrix) into L and U and the permutations for pivots
  //instead of just using lusolve i am doing this the hard way with lup to show my work
  //so L and U, in .lup are rearranged for efficiency and P returns that permutation info
  //need P to reorder rows of K.
  //if NOT done, would be like performing row operations on ONLY coeffs, not b elements
  let factored = math.lup(A);

  let L = toJSArray(factored.L);
  let U = toJSArray(factored.U);
  let p = factored.p;

  //find largest absolute val  in A (K matrix)
  let scale = 1;

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      let value = Math.abs(A[i][j]);
      if (value > scale) {
        scale = value;
      }
    }
  }

  //checks U's diagonal for almost 0 entries (using scale and tolerance avoids missing
  //vals like 0.0001
  let singularAt = null;

  for (let i = 0; i < size; i++) {
    if (Math.abs(U[i][i]) < tolerance * scale) {
      singularAt = i;
      break;
    }
  }

  // reaarange b to match row permutations. with .lup(), LU=PA
  let Fpermuted = [];

  for (let i = 0; i < size; i++) {
    Fpermuted.push(b[p[i]]);
  }

  //stop for  singular matrices
  if (singularAt !== null) {
    return {
      L: L,
      U: U,
      p: p,
      Fp: Fpermuted,
      singular: true,
      singularAt: singularAt,
    };
  }

  //Ly=Pb
  let yMatrix = toJSArray(math.lsolve(factored.L, Fpermuted));

  let y = [];

  for (let i = 0; i < size; i++) {
    y.push(Array.isArray(yMatrix[i]) ? yMatrix[i][0] : yMatrix[i]);
  }

  //Ux=y
  let xMatrix = toJSArray(math.usolve(factored.U, y));

  let x = []; //now x is actually nodal displacements but that's not what the truss solver
  //is solving for

  for (let i = 0; i < size; i++) {
    x.push(Array.isArray(xMatrix[i]) ? xMatrix[i][0] : xMatrix[i]);
  }
  //at the end you get L and U (needed to show my steps), P (not really needed),
  //Fp (permuted/reordered F matrix), y as the intermediate Ly=Pb product (needed in show
  //steps), x as the nodal displacements, and that the matrix isnt singular
  return {
    L: L,
    U: U,
    p: p,
    Fp: Fpermuted,
    y: y,
    x: x,
    singular: false,
  };
}

//must start culling fixed DOFs from the K and F matrices
//consider in Ku=F that node 1 x dir is fixed due to a pin. then u2 (n1x) = 0 since
//u2 = displacement of node 1 in the x dir = 0. then Ku=F, that Ku entry would be zero
//many cases of that exist so must cull fixed DOF entries
function partition(truss, dofCount) {
  let fixed = fixedDofs(truss.supports); //generates all fixed DOFs using the supports
  //each fixed DOF info obj looks like { dof: 2 * s.node, node: s.node, axis: "x" }
  let free = [];

  for (let i = 0; i < dofCount; i++) {
    let isFixed = false;

    for (let j = 0; j < fixed.length; j++) {
      if (fixed[j].dof === i) {
        isFixed = true;
        break;
      }
    }

    if (isFixed === false) {
      free.push(i);
    }
  }
  //at the end we get an object of two arrays, free DOF indices and fixed DOF indices
  //free might look like [0,2,5,9,14] and fixed would be all the other ones
  return {
    free: free,
    fixed: fixed,
  };
}
//builds Kff * uf = Ff by only keeping free  (not fixed) rows/cols of K anbd F
//say K was
// 10 1 2 3
// 1 20 4 5
// 2 4 30 6
// 3 5 6 40
//and free DOF array was [1,3], Kff would only be
// 20 5
// 5 40
//since we only keep rows 1 and 3, and within that only cols 1 and 3 since K is square
function reduce(K, F, free) {
  let Kff = [];
  let Ff = [];

  for (let i = 0; i < free.length; i++) {
    let originalRow = free[i];
    let newRow = [];

    for (let j = 0; j < free.length; j++) {
      let originalColumn = free[j];

      newRow.push(K[originalRow][originalColumn]);
    }

    Kff.push(newRow);
    Ff.push(F[originalRow]);
  }

  return {
    Kff: Kff,
    Ff: Ff,
  };
}

//THE BIG ONE. when given the entire project's state object, calls all helper and
//computational functions thus far to catch errors, find u (nodal displacements), find
//uf (displacements at only free DOFs), checks Ku-F=0 to ensure accuracy, then most
//importantly gets member forces using the F=(EA/L)*deltaL (k*elongation) formula per
//member, then solves rxns
function solve(truss) {
  //check 4 errors
  let { errors, info } = validate(truss);
  if (errors.length) {
    return { ok: false, errors: errors, info: info };
    //if there are errors refuse to solve, give errors
  }

  //build global K and global F, grabs giant obj with
  let assembled = assembleKF(truss); //assembleKF() gives big object of the following:
  //{K, F, memPropertiesObj, dofLabels, number of DOFs}

  let K = assembled.K;
  let F = assembled.F;
  let geometry = assembled.allMemberPropertiesArray;
  let dofLabels = assembled.dofLabels;
  let dofCount = assembled.N;

  //filter free from fixed DOFs then make  Kff and Ff from K and F
  let parts = partition(truss, dofCount);
  let free = parts.free;
  let fixed = parts.fixed;
  let reduced = reduce(K, F, free);
  let Kff = reduced.Kff;
  let Ff = reduced.Ff;

  //solve Kff*uf = Ff with lu factorisation
  let lu = LUsolve(Kff, Ff);
  // RECALL this lu object is now
  // function LUsolve(A: any, b: any): {
  //   L: any;
  //   U: any;
  //   p: any;
  //   Fp: any[];
  //   y: any[];
  //   x: any[];
  //   singular: boolean;
  //   singularAt?: undefined;
  // }

  //whether factorisation is successful these results always exist
  let baseInfo = {
    info: info,
    K: K,
    F: F,
    dofLabels: dofLabels,
    geometry: geometry,
    free: free,
    fixed: fixed,
    Kff: Kff,
    Ff: Ff,
    lu: lu,
  };

  if (lu.singular) {
    //this can happen even if statically determinate due to entire structure sliding or rotating
    return {
      ...baseInfo,
      ok: false,
      errors: [
        "Reduced stiffness matrix Kff has no unique solution, check truss DOFs and try again.",
      ],
    };
  }

  //makes displacement vector for ALL DOFs. uf, the x solution to the LU solving, is only
  //the displacements at free DOFs. just insert them into a vector of all DOFs, where
  //displacements for fixed DOFs is 0
  let uf = lu.x;
  let u = [];
  //push zeroes onto u array for all DOFs
  for (let i = 0; i < dofCount; i++) {
    u.push(0);
  }
  //for DOFs that were free, replace the zeroes with uf solution values
  for (let i = 0; i < free.length; i++) {
    let dof = free[i];
    u[dof] = uf[i];
  }

  //find Ku - F at all DOFs, should all be 0!
  let difference = [];

  for (let i = 0; i < dofCount; i++) {
    let total = -F[i];

    for (let j = 0; j < dofCount; j++) {
      total += K[i][j] * u[j];
    }

    difference.push(total);
  }

  //calculate support reactions per node
  let reactions = [];

  for (let i = 0; i < fixed.length; i++) {
    let fixedDof = fixed[i];
    let node = fixedDof.node;
    let reaction = null;

    //see if node already has existing reactions
    for (let j = 0; j < reactions.length; j++) {
      if (reactions[j].node === node) {
        reaction = reactions[j];
        break;
      }
    }

    //if not, create reactions x=0, y=0
    if (reaction === null) {
      reaction = {
        node: node,
        fx: 0,
        fy: 0,
      };

      reactions.push(reaction);
    }

    //use the axis entry of every fixedDOF object to match x to x and y to y
    if (fixedDof.axis === "x") {
      reaction.fx = difference[fixedDof.dof];
    } else {
      reaction.fy = difference[fixedDof.dof];
    }
  }

  //IMPORTANT!! calculates force and stress per member
  let memberResults = [];

  for (let i = 0; i < geometry.length; i++) {
    let memberInfo = geometry[i];
    //difference in horiz displacement of two nodes of member
    let dux = u[2 * memberInfo.b] - u[2 * memberInfo.a];
    //difference in vert displacement of two nodes of member
    let duy = u[2 * memberInfo.b + 1] - u[2 * memberInfo.a + 1];

    //deltaL = deltaux*cos(theta) + deltauy*sin(theta)
    let elongation = dux * memberInfo.c + duy * memberInfo.s;
    //F (or N for normal force) = k0*deltaL or (EA/L)deltaL
    let force = memberInfo.k0 * elongation;
    //stress is force over cross sec area
    let stress = force / memberInfo.A;

    memberResults.push({
      p: memberInfo.p,
      elongation: elongation,
      force: force,
      stress: stress,
    });
  }

  //make an answer array of ONLY member forces
  let memberForces = [];

  for (let i = 0; i < memberResults.length; i++) {
    memberForces.push(memberResults[i].force);
  }

  //return all parts for solution and solution steps
  return {
    ...baseInfo,
    ok: true,
    errors: [],
    u: u,
    uf: uf,
    resid: difference,
    memberResults: memberResults,
    memberForces: memberForces,
    reactions: reactions,
  };
}

//entire solve button functions
//obviously when user hits solve call the big solve function
document.getElementById("solve").onclick = () => {
  let solved = solve(state);
  let msg = document.getElementById("message");
  if (solved.ok === false) {
    state.result = null;
    state.lastSolve = null;
    msg.className = "status error";
    msg.textContent = solved.errors.join(" ");
  } else {
    state.result = solved;
    state.lastSolve = solved;
    msg.className = "status success";
    msg.textContent =
      "Truss solved successfully! Positive member forces are tension (colored blue), negative member forces are compression (colored red).";
  }
  refresh();
  renderWorking();
};

//now that primary calcs are done must log everything for transparency, like showing steps
function matrixToTable(matrix, labels) {
  //recall html tables have a head (obvi the headers like in an excel file) and the table body
  //where all the data are
  //build column headings of table bty filling in with specified labels per table
  let head = "<tr><th></th>";
  for (let i = 0; i < labels.length; i++) {
    head += '<th class="dof">' + labels[i] + "</th>";
  }
  head += "</tr>"; //closes th (table head) element

  //builds rows of the table using matrix rows
  let body = "";

  for (let i = 0; i < matrix.length; i++) {
    body += '<tr><th class="rowlab">' + labels[i] + "</th>";

    //fill in each cell of the row with matrix data
    for (let j = 0; j < matrix[i].length; j++) {
      let value = matrix[i][j];
      let cellClass = "nonzero";

      if (Math.abs(value) < tolerance) {
        cellClass = "zero";
      }
      //add the table data element to the tbody html
      body += '<td class="' + cellClass + '">' + rounder(value) + "</td>";
    }

    body += "</tr>";
  }

  return (
    //returns html literal  for entire table
    '<table class="mat amat">' + head + "<tbody>" + body + "</tbody></table>"
  );
}

//first step of show your work: local member tables

function elementHTML(solved) {
  //build summary table with  #	Nodes	dx	dy	Length	c = dx/L	s = dy/L	E	A	k₀ = EA/L
  let rows = "";
  //recall solved.gemoetry is the array of the objects having properties of all members
  for (let i = 0; i < solved.geometry.length; i++) {
    let memberInfo = solved.geometry[i];

    rows += `<tr>
            <td>${memberInfo.p}</td>
            <td>${memberInfo.a}-${memberInfo.b}</td> 
            <td>${rounder(memberInfo.dx)}</td>
            <td>${rounder(memberInfo.dy)}</td>
            <td>${rounder(memberInfo.L)}</td>
            <td>${rounder(memberInfo.c)}</td>
            <td>${rounder(memberInfo.s)}</td>
            <td>${rounder(memberInfo.E, 0)}</td>
            <td>${rounder(memberInfo.A, 3)}</td>
            <td>${rounder(memberInfo.k0)}</td>
        </tr>`;
  }

  //make individual member matrices section with rotation matrix T, local stiffness matrix
  //k, and ke local stiffness matrix but in global coords
  let details = "";

  for (let i = 0; i < solved.geometry.length; i++) {
    let memberInfo = solved.geometry[i];

    let labels = [
      memberInfo.a + "x",
      memberInfo.a + "y",
      memberInfo.b + "x",
      memberInfo.b + "y",
    ];

    //grab T, kl, and ke again isntead of referring to state to avoid stale data

    let T = rotationMatrixT(memberInfo);
    let kl = localElementK(memberInfo.k0);
    let ke = elementK(memberInfo);

    details += `
            <details class="mem-detail">
                <summary>
                    Member ${memberInfo.p} (nodes ${memberInfo.a}-${memberInfo.b}):
                    T, k_local, and
                    k_e = transpose(T)(k_local*T)
                </summary>

                <div class="mem-detail-body">
                    <div class="mem-col">
                        <p class="cap">Rotation T (global coords to local coords)</p>
                        ${matrixToTable(T, labels)}
                    </div>

                    <div class="mem-col">
                        <p class="cap">
                            Local stiffness matrix k_local =
                            k_0*[local node axial displacements]
                        </p>
                        ${matrixToTable(kl, ["u_1", "v_1", "u_2", "v_2"])}
                    </div>

                    <div class="mem-col">
                        <p class="cap">
                            k_e = transpose(T)(k_local*T)
                            (in GLOBAL xy coordinates, N/m)
                        </p>
                        ${matrixToTable(ke, labels)}
                    </div>
                </div>
            </details>
        `;
  }

  //explain step 1, grabbing member property matrices
  return `
        <h3>Step 1: Assess member properties and derive member stiffness matrices</h3>

        <p>
            A key principle of the matrix stiffness method is that each member
            has the behavior of a spring along its main axis, that it resists
            purely axial compression and tension like a spring does, with axial
            stiffness constant k_0 = EA/L. In a hypothetical localised coordinate
            system where the u axis runs along the member and the v axis runs
            perpendicular to the member, every member behaves as a 1D spring:
            k_axial = k_0*[[1,-1], [-1,1]], where the matrix has cols and rows u1 and u2. 
            Why this matrix? Members resist relative moment between the endpoints. 
            If node 1 or node 2 displace, causing a nonzero u1 or u2,
            that same node will make a restoring force (positive sign). Now, at the same time,
            a u1 or u2 displacement will cause the other node to make a negative restoring force 
            (negative sign). Same logic for u2. This means, if u1 and u2 are the same 
            (both nodes 1 and 2) moved the same distance axially, forces at the pins are 0! If 
            u2 is greater than u1, force @ node 2 will be positive (to stretch the member in the +u)
            , and force @ node 1 will be equal and opposite (negative).
            Now construct a larger 4x4 k_local matrix that also includes 
            transverse displacements and stiffnesses (these are revealed to be 0). 
            In the expanded 4x4 k_local 
            (taken from k_axial) matrix, only the u1-u1, u1-u2, u2-u1, and 
            u2-u2 entries are nonzero because the idealised pinned two-force
            members can only resist displacements along the u axis (axial 
            compression or elongation). It cannot resist any nodes moving
            perpendicular to the main axis since our idealised members have 0 
            resistance to transverse displacement (hence all v-v stiffnesses are 0). 
            Idealised members in the world of this simulator do not incur bending moments, 
            so any u-v stiffnesses are also 0.
            The rotation matrix T converts global xy displacements into local axial (u) and 
            transverse (v) displacements using the member's own unit vector (c,s) =
            (dx/L,dy/L). If you move any node 1 unit in the global x or y direction,
            its entry within a member's rotation matrix T shows how much displacement
            there would be relative to that member's main axis as defined per member.
            With these three parts we can derive a 4x4 matrix k_e (stiffness matrix of
            each element) in terms of GLOBAL coordinates. Recall k_local is defined in 
            the u,v axial coordinates of each member. The transformation matrix T of each
            member converts global displacements to local displacements (axial, and transverse=0). First, 
            multiply the matrices k_local (stiffnesses in N/m) and T (dimensionless ratios)
            to get a matrix that describes how nodal displacements (in global xy coordinates)
            induce local axial forces in the member. This intermediate is in terms of N/m, and
            the values are relationships between forces and displacements. Then, multiply the
            intermediate matrix by transpose(T), converting the local axial stiffness coefficients to 
            global force-displacement coefficients. k_e can now map all four global displacements across both node
            to all four global forces at the four DOFs (e.g. n0x, n0y, n1x, n1y),
            and the k_e matrices of all members can be combined, as in the next step.
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Nodes</th>
                        <th>dx</th>
                        <th>dy</th>
                        <th>Length</th>
                        <th>c = dx/L</th>
                        <th>s = dy/L</th>
                        <th>E</th>
                        <th>A</th>
                        <th>k&#8320; = EA/L</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>

        <div class="mem-details">${details}</div>
    `;
}

//onto step 2 and the big global stiffness matrix

function KMatrixHTML(solved) {
  let K = solved.K; //assembleKF returns solved obj with a K matrix in it
  let dofLabels = solved.dofLabels;

  //col headings, now recall the BIG table must have a row/col per DOF (lots of em!)
  let head = "<tr><th></th>";

  for (let j = 0; j < dofLabels.length; j++) {
    head += '<th class="dof">' + dofLabels[j] + "</th>";
  }

  head += "</tr>";

  //rows and cells fill in
  let body = "";

  for (let i = 0; i < K.length; i++) {
    body += '<tr><th class="rowlab">' + dofLabels[i] + "</th>";

    for (let j = 0; j < K[i].length; j++) {
      let value = K[i][j];
      let cellClass = "nz";

      if (Math.abs(value) < tolerance) {
        cellClass = "z";
      }

      body += '<td class="' + cellClass + '">' + rounder(value) + "</td>";
    }

    body += "</tr>";
  }

  return `
        <h3>Step 2: Compose global stiffness matrix K</h3>

        <p>
            K starts as a square matrix of zeroes, where both the rows and columns are
            ordered n0x (the DOF of node 0, x), n0y, n1x, etc. Each member adds its
            4x4 element stiffness matrix k_e from before to
            the rows and columns corresponding to the member's two end nodes.
            Every new stiffness contribution to a cell of big K is added to the existing 
            entry in that cell. When different members share a node, their contributions 
            accumulate in the rows and columns for that node's DOF.
            This process of summing stiffness coefficients for each DOF composes the final 
            global stiffness matrix K.
        </p>

        <div class="scroll">
            <table class="mat amat">
                ${head}
                <tbody>${body}</tbody>
            </table>
        </div>

        <p class="hint">
            K_ij describes how displacement at degree of
            freedom j contributes to the force at degree of freedom i.
            It is the force contribution per unit
            displacement at j when all other degrees of freedom are
            held at zero. K is symmetric, so K_ij =
            K_ji.
        </p>
    `;
}

function boundarycondHTML(solved) {
  let K = solved.K;
  let fixed = solved.fixed;
  let free = solved.free;
  let dofLabels = solved.dofLabels;
  let Ff = solved.Ff;

  //col headings, literally same as the global K in step 2
  let head = "<tr><th></th>";

  for (let j = 0; j < dofLabels.length; j++) {
    head += '<th class="dof">' + dofLabels[j] + "</th>";
  }

  head += "</tr>";

  //rows and cells
  let body = "";

  for (let i = 0; i < K.length; i++) {
    body += '<tr><th class="rowlab">' + dofLabels[i] + "</th>";

    for (let j = 0; j < K[i].length; j++) {
      body += "<td>" + rounder(K[i][j]) + "</td>";
    }

    body += "</tr>";
  }

  //make a table listing the fixed DOFs that will be pulled away when making Kff
  let fixedRows = "";

  for (let i = 0; i < fixed.length; i++) {
    let f = fixed[i];

    fixedRows += `
            <tr>
                <td>${dofLabels[f.dof]}</td>
                <td>Node ${f.node}, ${f.axis}</td>
                <td>Fixed: u = 0</td>
            </tr>
        `;
  }

  //list applied loads at the free DOFs
  let freeRows = "";

  for (let i = 0; i < free.length; i++) {
    let dof = free[i];

    freeRows += `
            <tr>
                <td>${dofLabels[dof]}</td>
                <td>${rounder(Ff[i])}</td>
            </tr>
        `;
  }

  return `
        <h3>Step 3: Apply boundary conditions</h3>

        <p>
            Certain supports constrain certain degrees of freedom to have zero
            displacement. These create fixed DOFs. For example, a pin support at a node 0
            creates fixed x and y DOFs since displacement must be 0 in all directions.
            Because displacements at <b>fixed</b> DOFs are known to be 0, we only need to solve for
            the remaining <b>free</b> DOFs. That is why we select the rows and
            columns of K corresponding to the free DOFs to compose a
            reduced stiffness matrix K_ff (K_freefree, both rows and cols are of free DOFs).
        </p>

        <div class="scroll">
            <table class="mat amat bc">
                ${head}
                <tbody>${body}</tbody>
            </table>
        </div>

        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        <th>Fixed DOF</th>
                        <th>Where</th>
                        <th>Constraint</th>
                    </tr>
                </thead>
                <tbody>${fixedRows}</tbody>
            </table>
        </div>

        <p>
            The reduced system consisting of only free DOFs is
            K_ff * u_f = F_f. LU decomposition will be performed on 
            <b>this</b> system to find nodal displacements. The load vector F_f
            is as follows in the table below. Zero values simply mean there were no
            EXTERNAL loads at that DOF (not necessarily that node).
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        <th>Free DOF</th>
                        <th>F [N]</th>
                    </tr>
                </thead>
                <tbody>${freeRows}</tbody>
            </table>
        </div>
    `;
}

//time to show work for LU decomp
function luHTML(solved) {
  let lu = solved.lu;

  if (!lu) {
    return "";
  }

  //get free DOF labels from solved.free array
  let labels = [];

  for (let i = 0; i < solved.free.length; i++) {
    let dof = solved.free[i];
    labels.push(solved.dofLabels[dof]);
  }

  //for post pivot table, get the right label order by permutations
  let pLabels = [];

  for (let i = 0; i < lu.p.length; i++) {
    pLabels.push(labels[lu.p[i]]);
  }

  let intro = `
        <h3>Step 4: Decompose K_ff into LU = P(K_ff), then solve by LU decomposition</h3>

        <p>
            IMPORTANT: The math.js math.lup(A) function was used to perform a specialised
            LUP decomposition where a permutation matrix P is multiplied to K_ff to reorder
            K_ff rows for efficiency and stability in solving, then LU=P(K_ff). I set
            up Ly=b and Ux=y as normal and used math.js to solve for [x] = [u_f].
            This way is more demonstrative than simply math.lusolve(A) which only returns [x] = [u_f].
        </p>
    `;

  // Handle a singular matrix.
  if (lu.singular === true) {
    return (
      intro +
      `
            <p>
                There is a diagonal entry of U that is
                zero at row ${lu.singularAt}
                (${pLabels[lu.singularAt]}). The system cannot
                be solved reliably since K_ff is singular. Inspect truss or code.
            </p>

            <div class="scroll">
                <div class="sys">
                    <div>
                        <p class="cap">L</p>
                        ${matrixToTable(lu.L, pLabels)}
                    </div>

                    <span class="eq">&middot;</span>

                    <div>
                        <p class="cap">U</p>
                        ${matrixToTable(lu.U, pLabels)}
                    </div>
                </div>
            </div>
        `
    );
  }

  //build P(Kff) table
  let reorderedK = [];

  for (let i = 0; i < lu.p.length; i++) {
    reorderedK.push(solved.Kff[lu.p[i]]);
  }

  //build b = P * Ff table
  let bRows = "";

  for (let i = 0; i < lu.Fp.length; i++) {
    bRows += `
            <tr>
                <td>${pLabels[i]}</td>
                <td>${rounder(lu.Fp[i])}</td>
            </tr>
        `;
  }

  //build y table
  let yRows = "";

  for (let i = 0; i < lu.y.length; i++) {
    yRows += `
            <tr>
                <td>${pLabels[i]}</td>
                <td class="xval">${rounder(lu.y[i], 6)}</td>
            </tr>
        `;
  }

  //build solution table x AKA u_f
  let xRows = "";

  for (let i = 0; i < lu.x.length; i++) {
    xRows += `
            <tr>
                <td>${labels[i]}</td>
                <td class="xval">${rounder(lu.x[i], 6)}</td>
            </tr>
        `;
  }

  return (
    intro +
    `
        <div class="scroll">
            <div class="sys">
                <div>
                    <p class="cap">L (lower triangular)</p>
                    ${matrixToTable(lu.L, pLabels)}
                </div>

                <span class="eq">&middot;</span>

                <div>
                    <p class="cap">U (upper triangular)</p>
                    ${matrixToTable(lu.U, pLabels)}
                </div>

                <span class="eq">=</span>

                <div>
                    <p class="cap">P(K_ff), after K_ff rows were reordered by P</p>
                    ${matrixToTable(reorderedK, pLabels)}
                </div>
            </div>
        </div>

        <p>
            Apply the same permutation P to the load vector F_f:
            b = P * F_f.
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr><th>Row</th><th>b [N]</th></tr>
                </thead>
                <tbody>${bRows}</tbody>
            </table>
        </div>

        <p>
            <strong>Ly = b</strong>, forward substitution solved by math.js:
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr><th>Row</th><th>y</th></tr>
                </thead>
                <tbody>${yRows}</tbody>
            </table>
        </div>

        <p>
            <strong>Ux = y</strong>, where x = u_f, back substitution solved by math.js:
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        <th>Free DOF</th>
                        <th>Displacement u<sub>f</sub> [m]</th>
                    </tr>
                </thead>
                <tbody>${xRows}</tbody>
            </table>
        </div>
    `
  );
}

//show the final full u vector (both fixed and free) with computed displacements
function uHTML(solved) {
  if (solved.ok === false) return "";

  let dofLabels = solved.dofLabels;
  let u = solved.u;
  let fixed = solved.fixed;
  let resid = solved.resid;

  let rows = "";

  for (let i = 0; i < dofLabels.length; i++) {
    let isFixed = false;

    for (let j = 0; j < fixed.length; j++) {
      if (fixed[j].dof === i) {
        isFixed = true;
        break;
      }
    }

    let reactionText = "";

    if (isFixed === true) {
      reactionText =
        '<span class="reaction">' +
        rounder(resid[i], 4) +
        " N (reaction)</span>";
    } else {
      reactionText = "~ 0 (equilibrium)";
    }

    rows += `
            <tr>
                <td>${dofLabels[i]}</td>
                <td class="xval">${rounder(u[i], 6)}</td>
                <td>${reactionText}</td>
            </tr>
        `;
  }

  return `
        <h3>Step 5: Compose u vector and compute support reactions</h3>

        <p>
            Combine free displacements and respective DOFs from Step 4 with zero
            displacement at all fixed DOFs to compose full displacement vector u. 
            This is the main goal of the matrix stiffness method, to find where all nodes
            displace after loads are applied. With the system K matrix, u vector, and 
            F vector, it is possible to assemble F = Ku for each node. 
            Substituting u into K*u - F gives support reactions at fixed DOFs. 
            At free DOFs, the result should be zero because LUP solving should have computed
            satisfactory values of u such that F = K*u.
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        <th>DOF</th>
                        <th>u [m]</th>
                        <th>K*u - F</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function forcesHTML(solved) {
  if (solved.ok === false) return "";

  let rows = "";

  for (let i = 0; i < solved.memberResults.length; i++) {
    let r = solved.memberResults[i];
    let fclass = forceClass(r.force);

    rows += `
            <tr>
                <td>${r.p}</td>
                <td class="${fclass}">${rounder(r.elongation, 6)}</td>
                <td class="${fclass}">${rounder(r.force, 4)}</td>
                <td class="${fclass}">${rounder(r.stress, 4)}</td>
            </tr>
        `;
  }

  return `
        <h3>Step 6: Solve for member forces</h3>

        <p>
            For each member, the change in length is the relative
            displacement of the two nodes projected onto the
            member's axis:
            ΔL = (u_b - u_a)*(c, s).
            Recall Hooke's Law when finding the member forces: similar to F = kΔx,
            F = k_0*ΔL = (EA/L)*ΔL.
            Positive force is tension/elongation, and
            negative force is compression/shortening.
        </p>

        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        <th>Member</th>
                        <th>ΔL [m]</th>
                        <th>Force [N]</th>
                        <th>Stress [GPa]</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function renderWorking() {
  let sec = document.getElementById("steps");
  let solved = state.lastSolve;
  if (!solved) {
    sec.hidden = true;
    sec.innerHTML = "";
    return;
  }
  sec.hidden = false;
  sec.innerHTML =
    `<h2>Steps to solution</h2>` +
    elementHTML(solved) +
    KMatrixHTML(solved) +
    boundarycondHTML(solved) +
    luHTML(solved) +
    uHTML(solved) +
    forcesHTML(solved);
}

function resizeCanvas() {
  let r = canvas.getBoundingClientRect();
  pixelRatio = window.devicePixelRatio || 1;
  canvaswidth = r.width;
  canvasheight = r.height;
  canvas.width = Math.round(canvaswidth * pixelRatio);
  canvas.height = Math.round(canvasheight * pixelRatio);
  if (!viewInitialised) {
    viewInitialised = true;
    fitView();
  } else draw();
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
document.getElementById("example").onclick();

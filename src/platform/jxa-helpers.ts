// JXA helper function templates for macOS accessibility scripts.
// Each function returns a JXA code string that can be embedded in osascript calls.

export function jxaChildElements(): string {
  return `
      function childElements(elem) {
        try { return elem.uiElements(); } catch(e1) {
          try { return elem.elements(); } catch(e2) { return []; }
        }
      }`;
}

export function jxaResolveElementByFullPath(): string {
  return String.raw`
      function resolveElementByFullPath(path) {
        var parts = path.split('/');
        if (parts.length < 2) return null;

        var procName = parts[0];
        var winPart = parts[1];
        var winIdx = 0;
        var match = winPart.match(/^win(\d+)$/);
        if (match) {
          winIdx = parseInt(match[1]);
        }

        try {
          var proc = se.processes[procName]();
          var wins = proc.windows();
          if (winIdx >= wins.length) return null;
          var current = wins[winIdx];

          for (var i = 2; i < parts.length; i++) {
            var idx = parseInt(parts[i]);
            if (isNaN(idx)) return null;
            try {
              var kids = childElements(current);
              if (idx >= kids.length) return null;
              current = kids[idx];
            } catch(e) { return null; }
          }
          return current;
        } catch(e) { return null; }
      }`;
}

export function jxaResolveElementInApp(): string {
  return String.raw`
      function resolveElementInApp(path, targetApp) {
        if (!targetApp) return null;
        var parts = path.split('/');
        var start = parts[0] === targetApp ? 1 : 0;
        var winPart = parts[start] || 'win0';
        var winIdx = 0;
        var match = winPart.match(/^win(\d+)$/);
        if (match) winIdx = parseInt(match[1]);

        try {
          var proc = se.processes[targetApp]();
          var wins = proc.windows();
          if (winIdx >= wins.length) return null;
          var current = wins[winIdx];
          for (var i = start + 1; i < parts.length; i++) {
            var idx = parseInt(parts[i]);
            if (isNaN(idx)) return null;
            try {
              var kids = childElements(current);
              if (idx >= kids.length) return null;
              current = kids[idx];
            } catch(e) { return null; }
          }
          return current;
        } catch(e) { return null; }
      }`;
}

export function jxaElemString(): string {
  return `
      function elemString(elem, getter) {
        try {
          var value = getter(elem);
          return value === undefined || value === null ? '' : String(value);
        } catch(e) {
          return '';
        }
      }`;
}

export function jxaGetBounds(): string {
  return `
      function getBounds(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          return {x: pos[0] || 0, y: pos[1] || 0, width: sz[0] || 0, height: sz[1] || 0};
        } catch(e) {
          return {x: 0, y: 0, width: 0, height: 0};
        }
      }`;
}

export function jxaIsVisible(): string {
  return `
      function isVisible(elem) {
        try {
          var pos = elem.position();
          var sz = elem.size();
          if (!pos || !sz) return false;
          return sz[0] > 0 && sz[1] > 0 && pos[0] > -10000 && pos[1] > -10000;
        } catch(e) {
          return false;
        }
      }`;
}

export function jxaDescriptorMatches(): string {
  return `
      function descriptorMatches(elem) {
        if (!cached) return true;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        if (cached.role && role && role !== cached.role) return false;
        if (cached.name && name && name !== cached.name) return false;
        if (cached.value && value && value !== cached.value) return false;
        if (cached.description && desc && desc !== cached.description) return false;
        return true;
      }`;
}

export function jxaScoreEquivalent(): string {
  return `
      function scoreEquivalent(elem) {
        if (!cached) return -1;
        var score = 0;
        var role = elemString(elem, function(e) { return e.role(); });
        var name = elemString(elem, function(e) { return e.name(); });
        var desc = elemString(elem, function(e) { return e.description(); });
        var value = elemString(elem, function(e) { return e.value(); });
        var subrole = elemString(elem, function(e) { return e.subrole(); });
        var identifier = elemString(elem, function(e) { return e.identifier(); });
        if (cached.role && role === cached.role) score += 4;
        if (cached.name && name === cached.name) score += 4;
        if (cached.value && value === cached.value) score += 3;
        if (cached.description && desc === cached.description) score += 2;
        if (cached.subrole && subrole === cached.subrole) score += 2;
        if (cached.identifier && identifier === cached.identifier) score += 3;
        var b = getBounds(elem);
        if (cached.bounds) {
          var cx = b.x + b.width / 2;
          var cy = b.y + b.height / 2;
          var ocx = cached.bounds.x + cached.bounds.width / 2;
          var ocy = cached.bounds.y + cached.bounds.height / 2;
          var distance = Math.sqrt(Math.pow(cx - ocx, 2) + Math.pow(cy - ocy, 2));
          if (distance < 8) score += 4;
          else if (distance < 40) score += 2;
          else if (distance < 120) score += 1;
        }
        return score;
      }`;
}

export function jxaRefetchEquivalent(): string {
  return `
      function refetchEquivalent() {
        if (!cached) return null;
        var targetApp = appName || cached.appName || '';
        var best = null;
        var bestScore = 0;
        var visited = [0];
        function visit(elem, depth) {
          if (visited[0] > 350 || depth > 10) return;
          visited[0]++;
          var score = scoreEquivalent(elem);
          if (score > bestScore) {
            best = elem;
            bestScore = score;
          }
          try {
            var kids = childElements(elem);
            for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
          } catch(e) {}
        }
        try {
          if (targetApp) {
            var proc = se.processes[targetApp]();
            var wins = proc.windows();
            for (var w = 0; w < wins.length; w++) visit(wins[w], 0);
          } else {
            var procs = se.processes();
            for (var p = 0; p < procs.length; p++) {
              try {
                var wins2 = procs[p].windows();
                for (var w2 = 0; w2 < wins2.length; w2++) visit(wins2[w2], 0);
              } catch(e2) {}
            }
          }
        } catch(e) {}
        return bestScore >= 6 ? best : null;
      }`;
}

/** Common helper set used by clickElement, typeInElement, setElementValue */
export function jxaElementActionHelpers(): string {
  return [
    jxaChildElements(),
    jxaResolveElementByFullPath(),
    jxaResolveElementInApp(),
    jxaElemString(),
    jxaGetBounds(),
    jxaDescriptorMatches(),
    jxaScoreEquivalent(),
    jxaRefetchEquivalent(),
  ].join("\n");
}

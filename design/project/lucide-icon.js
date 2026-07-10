/* Project standard: ALL icons must come from the lucide (lucide-react) icon set.
   Icons are rendered through this single React wrapper — never hand-author icon
   SVG per use. The node data below is copied verbatim from the lucide icon set.
   To add an icon: copy its node array from lucide-react and add it to ICONS
   under its kebab-case name.

   Usage in a .dc.html template:
     <x-import component-from-global-scope="LucideIcon" from="./lucide-icon.js"
               name="chevron-right" size="16" hint-size="16px,16px"
               style="display:inline-flex"></x-import>
   Props: name (kebab-case), size (px), color (default currentColor), strokeWidth (default 2). */
(function () {
  // lucide icon nodes: name -> [ [tag, attrs], ... ]
  var ICONS = {
    'send': [
      ['path', { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' }],
      ['path', { d: 'm21.854 2.147-10.94 10.939' }]
    ],
    'settings': [
      ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
      ['circle', { cx: 12, cy: 12, r: 3 }]
    ],
    'chevron-left': [
      ['path', { d: 'm15 18-6-6 6-6' }]
    ],
    'chevron-right': [
      ['path', { d: 'm9 18 6-6-6-6' }]
    ],
    'image': [
      ['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
      ['circle', { cx: 9, cy: 9, r: 2 }],
      ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]
    ],
    'arrow-up-right': [
      ['path', { d: 'M7 7h10v10' }],
      ['path', { d: 'M7 17 17 7' }]
    ],
    'trending-up': [
      ['path', { d: 'M16 7h6v6' }],
      ['path', { d: 'm22 7-8.5 8.5-5-5L2 17' }]
    ],
    'trending-down': [
      ['path', { d: 'M16 17h6v-6' }],
      ['path', { d: 'm22 17-8.5-8.5-5 5L2 7' }]
    ],
    'shield': [
      ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }]
    ],
    'target': [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['circle', { cx: 12, cy: 12, r: 6 }],
      ['circle', { cx: 12, cy: 12, r: 2 }]
    ],
    'circle-check': [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['path', { d: 'm9 12 2 2 4-4' }]
    ],
    'sparkles': [
      ['path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z' }],
      ['path', { d: 'M20 3v4' }],
      ['path', { d: 'M22 5h-4' }],
      ['path', { d: 'M4 17v2' }],
      ['path', { d: 'M5 18H3' }]
    ],
    'circle-plus': [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['path', { d: 'M8 12h8' }],
      ['path', { d: 'M12 8v8' }]
    ],
    'circle-minus': [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['path', { d: 'M8 12h8' }]
    ],
    'circle-x': [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['path', { d: 'm15 9-6 6' }],
      ['path', { d: 'm9 9 6 6' }]
    ],
    'search': [
      ['circle', { cx: 11, cy: 11, r: 8 }],
      ['path', { d: 'm21 21-4.3-4.3' }]
    ],
    'scissors': [
      ['circle', { cx: 6, cy: 6, r: 3 }],
      ['path', { d: 'M8.12 8.12 12 12' }],
      ['path', { d: 'M20 4 8.12 15.88' }],
      ['circle', { cx: 6, cy: 18, r: 3 }],
      ['path', { d: 'M14.8 14.8 20 20' }]
    ],
    'activity': [
      ['path', { d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' }]
    ],
    'layers': [
      ['path', { d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z' }],
      ['path', { d: 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' }],
      ['path', { d: 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' }]
    ],
    'coins': [
      ['circle', { cx: 8, cy: 8, r: 6 }],
      ['path', { d: 'M18.09 10.37A6 6 0 1 1 10.34 18' }],
      ['path', { d: 'M7 6h1v4' }],
      ['path', { d: 'm16.71 13.88.7.71-2.82 2.82' }]
    ],
    'log-out': [
      ['path', { d: 'm16 17 5-5-5-5' }],
      ['path', { d: 'M21 12H9' }],
      ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }]
    ]
  };

  function LucideIcon(props) {
    var R = window.React;
    var size = props.size || 16;
    var color = props.color || 'currentColor';
    var strokeWidth = props.strokeWidth != null ? props.strokeWidth : 2;
    var nodes = ICONS[props.name] || [];

    var kids = nodes.map(function (node, i) {
      var attrs = Object.assign({ key: i }, node[1]);
      return R.createElement(node[0], attrs);
    });

    return R.createElement('svg', {
      xmlns: 'http://www.w3.org/2000/svg',
      width: size, height: size, viewBox: '0 0 24 24',
      fill: 'none', stroke: color, strokeWidth: strokeWidth,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { display: 'block', flex: 'none' }
    }, kids);
  }

  window.LucideIcon = LucideIcon;
})();

import { encodeObject } from './spectra';
import { IEasyEDABoard } from './easyeda-types';

// doc: https://docs.easyeda.com/en/DocumentFormat/3-EasyEDA-PCB-File-Format/index.html#shapes

const layers: { [key: string]: string } = {
  1: 'F.Cu',
  2: 'B.Cu',
  3: 'F.SilkS',
  4: 'B.SilkS',
  5: 'F.Paste',
  6: 'B.Paste',
  7: 'F.Mask',
  8: 'B.Mask',
  10: 'Edge.Cuts',
  12: 'Cmts.User',
  13: 'F.Fab',
  14: 'B.Fab'
};

interface ICoordinates {
  x: number;
  y: number;
}

function kiUnits(value: string | number) {
  if (typeof value === 'string') {
    value = parseFloat(value);
  }
  return value * 10 * 0.0254;
}

function kiAngle(value: string) {
  const angle = parseFloat(value);
  if (!isNaN(angle)) {
    return angle > 180 ? -(360 - angle) : angle;
  }
  return null;
}

function kiCoords(x: string, y: string): ICoordinates {
  return {
    x: kiUnits(parseFloat(x) - 4000),
    y: kiUnits(parseFloat(y) - 3000)
  };
}

function kiAt(x: string, y: string, angle?: string, parentCoords: ICoordinates = { x: 0, y: 0 }) {
  const coords = kiCoords(x, y);
  return ['at', coords.x - parentCoords.x, coords.y - parentCoords.y, kiAngle(angle)];
}

function kiStartEnd(
  startX: string,
  startY: string,
  endX: string,
  endY: string,
  parentCoords: ICoordinates = { x: 0, y: 0 }
) {
  const start = kiCoords(startX, startY);
  const end = kiCoords(endX, endY);
  return [
    ['start', start.x - parentCoords.x, start.y - parentCoords.y],
    ['end', end.x - parentCoords.x, end.y - parentCoords.y]
  ];
}

function convertVia(args: string[], nets: string[], parentCoords?: ICoordinates) {
  const [x, y, diameter, net, drill, id, locked] = args;
  return [
    'via',
    kiAt(x, y, null, parentCoords),
    ['size', kiUnits(diameter)],
    ['drill', kiUnits(drill) * 2],
    ['layers', 'F.Cu', 'B.Cu'],
    ['net', nets.indexOf(net)]
  ];
}

function convertTrack(
  args: string[],
  nets: string[],
  objName = 'segment',
  parentCoords?: ICoordinates
) {
  const [width, layer, net, coords, id, locked] = args;
  const netId = nets.indexOf(net);
  const coordList = coords.split(' ');
  let result = [];
  for (let i = 0; i < coordList.length - 2; i += 2) {
    const layerName = layers[layer];
    result.push([
      objName,
      ...kiStartEnd(
        coordList[i],
        coordList[i + 1],
        coordList[i + 2],
        coordList[i + 3],
        parentCoords
      ),
      ['width', kiUnits(width)],
      ['layer', layerName],
      netId > 0 ? ['net', netId] : null,
      locked === '1' ? ['status', 40000] : null
    ]);
  }
  return result;
}

function textLayer(layer: string, footprint: boolean, isName: boolean) {
  const layerName = layers[layer];
  if (footprint && isName) {
    return layerName.replace('.SilkS', '.Fab');
  } else {
    return layerName;
  }
}

function convertText(args: string[], objName = 'gr_text', parentCoords?: ICoordinates) {
  const [
    type, // N/P/L (Name/Prefix/Label)
    x,
    y,
    lineWidth,
    angle,
    mirror,
    layer,
    net,
    fontSize,
    text,
    path,
    display,
    id,
    font,
    locked
  ] = args;
  const layerName = textLayer(layer, objName === 'fp_text', type === 'N');
  const fontTable: { [key: string]: { width: number; thickness: number } } = {
    'NotoSerifCJKsc-Medium': { width: 0.8, thickness: 0.3 },
    'NotoSansCJKjp-DemiLight': { width: 0.6, thickness: 0.5 }
  };
  const fontMultiplier = font in fontTable ? fontTable[font] : { width: 1, thickness: 1 };
  const actualFontSize = kiUnits(fontSize) * fontMultiplier.width;
  return [
    objName,
    objName === 'fp_text' ? (type === 'P' ? 'reference' : 'value') : null,
    text,
    kiAt(x, y, angle, parentCoords),
    ['layer', layerName],
    display === 'none' ? 'hide' : null,
    [
      'effects',
      [
        'font',
        ['size', actualFontSize, actualFontSize],
        ['thickness', kiUnits(lineWidth) * fontMultiplier.thickness]
      ],
      ['justify', 'left', layerName[0] === 'B' ? 'mirror' : null]
    ]
  ];
}

export function convertArc(args: string[]) {
  const [width, layer, net, path, _, id, locked] = args;
  const [match, startPoint, arcParams] = /^M\s*([\d.\s]+)A\s*([\d.\s]+)$/.exec(
    path.replace(/[,\s]+/g, ' ')
  );
  const [startX, startY] = startPoint.split(' ');
  const [rx, ry, xAxisRotation, largeArc, sweep, endX, endY] = arcParams.split(' ');
  const start = kiCoords(startX, startY);
  const end = kiCoords(endX, endY);
  return [
    'gr_arc',
    ['start', (start.x + end.x) / 2, (start.y + end.y) / 2], // actually center
    ['end', start.x, start.y],
    ['angle', 180],
    ['width', kiUnits(width)],
    ['layer', layers[layer]]
  ];
}

function convertFpArc(args: string[], parentCoords: ICoordinates) {
  const [width, layer, net, path, _, id, locked] = args;
  const drawingParts = path.split(' ');
  const [startX, startY] = drawingParts.slice(1, 3);
  const [endX, endY] = drawingParts.slice(9);
  const xAxisRotation = parseFloat(drawingParts[6]);
  const start = kiCoords(startX, startY);
  const end = kiCoords(endX, endY);
  return [
    'fp_arc',
    ['start', (start.x + end.x) / 2, (start.y + end.y) / 2], // actually center
    ['end', end.x, end.y],
    ['angle', 180],
    ['width', kiUnits(width)],
    ['layer', layers[layer]]
  ];
}

function convertPad(args: string[], nets: string[], parentCoords: ICoordinates) {
  const [
    shape,
    x,
    y,
    width,
    height,
    layerId,
    net,
    num,
    holeRadius,
    points,
    id,
    holeLength,
    holePoints,
    plated,
    locked
  ] = args;
  // TODO figure out angle from points
  const shapes: { [key: string]: string } = {
    ELLIPSE: 'circle',
    RECT: 'rect',
    OVAL: 'oval',
    POLYGON: 'custom'
  };
  const netId = nets.indexOf(net);
  const drill = kiUnits(holeRadius);
  const layers: { [key: string]: string[] } = {
    1: ['F.Cu', 'F.Paste', 'F.Mask'],
    2: ['B.Cu', 'B.Paste', 'B.Mask'],
    11: ['*.Cu', '*.Paste', '*.Mask']
  };
  const padNum = parseInt(num, 10);
  return [
    'pad',
    isNaN(padNum) ? num : padNum,
    drill > 0 ? 'thru_hole' : 'smd',
    shapes[shape],
    kiAt(x, y, null, parentCoords),
    ['size', kiUnits(width), kiUnits(height)],
    ['layers', ...layers[layerId]],
    drill ? ['drill', drill * 2] : null,
    netId > 0 ? ['net', netId, net] : null
  ];
}

function convertHole(args: string[], parentCoords: ICoordinates) {
  const [x, y, radius, id, locked] = args;
  const size = kiUnits(radius) * 2;
  return [
    'pad',
    '',
    'np_thru_hole',
    'circle',
    kiAt(x, y, null, parentCoords),
    ['size', size, size],
    ['drill', size],
    ['layers', '*.Cu', '*.Mask']
  ];
}

function convertLib(args: string[], nets: string[]) {
  const [x, y, attributes, rotation, importFlag, id, locked] = args;
  const shapeList = args
    .join('~')
    .split('#@$')
    .slice(1);
  let shapes = [];
  const coordinates = kiCoords(x, y);
  for (const shape of shapeList) {
    const shapeParts = shape.split('~');
    if (shapeParts[0] === 'TRACK') {
      shapes.push(...convertTrack(shapeParts.slice(1), nets, 'fp_line', coordinates));
    } else if (shapeParts[0] === 'TEXT') {
      shapes.push(convertText(shapeParts.slice(1), 'fp_text', coordinates));
    } else if (shapeParts[0] === 'ARC') {
      shapes.push(convertFpArc(shapeParts.slice(1), coordinates));
    } else if (shapeParts[0] === 'HOLE') {
      shapes.push(convertHole(shapeParts.slice(1), coordinates));
    } else if (shapeParts[0] === 'PAD') {
      shapes.push(convertPad(shapeParts.slice(1), nets, coordinates));
    } else {
      console.log(shapeParts[0]);
    }
  }

  return ['module', `Imported:${id}`, ['layer', 'F.Cu'], kiAt(x, y), ...shapes];
}

function convertCopperArea(args: string[], nets: string[]) {
  const [
    strokeWidth,
    layerId,
    net,
    points,
    clearanceWidth,
    fillStyle,
    id,
    thermal,
    keepIsland,
    copperZone,
    locked
  ] = args;
  const netId = nets.indexOf(net);
  // fill style: solid/none
  // id: gge27
  // thermal: spoke/direct
  const pointList = points.split(' ').filter((p) => !isNaN(parseFloat(p)));
  const polygonPoints = [];
  for (let i = 0; i < pointList.length; i += 2) {
    const coords = kiCoords(pointList[i], pointList[i + 1]);
    polygonPoints.push(['xy', coords.x, coords.y]);
  }
  return [
    'zone',
    ['net', netId],
    ['net_name', net],
    ['layer', layers[layerId]],
    ['hatch', 'edge', 0.508],
    ['connect_pads', ['clearance', kiUnits(clearanceWidth)]],
    // TODO (min_thickness 0.254)
    // TODO (fill yes (arc_segments 32) (thermal_gap 0.508) (thermal_bridge_width 0.508))
    ['polygon', ['pts', ...polygonPoints]]
  ];
}

function convertShape(shape: string, nets: string[]) {
  const [type, ...args] = shape.split('~');
  switch (type) {
    case 'VIA':
      return [convertVia(args, nets)];
    case 'TRACK':
      return [...convertTrack(args, nets)];
    case 'TEXT':
      return [convertText(args)];
    case 'ARC':
      return [convertArc(args)];
    case 'COPPERAREA':
      return [convertCopperArea(args, nets)];
    case 'LIB':
      return [convertLib(args, nets)];
    default:
      console.error('Unsupported shape', type);
      return null;
  }
}

function flatten<T>(arr: T[]) {
  return [].concat(...arr);
}

export function convertBoard(input: IEasyEDABoard) {
  const { nets } = input.routerRule;
  nets.unshift(''); // Kicad expects net 0 to be empty
  const outputObjs = [
    ...nets.map((net, idx) => ['net', idx, net]),
    ...flatten(input.shape.map((shape) => convertShape(shape, nets)))
  ];

  let output = `
(kicad_pcb (version 20171130) (host pcbnew "(5.0.2)-1")

(page A4)
(layers
  (0 F.Cu signal)
  (31 B.Cu signal)
  (32 B.Adhes user)
  (33 F.Adhes user)
  (34 B.Paste user)
  (35 F.Paste user)
  (36 B.SilkS user)
  (37 F.SilkS user)
  (38 B.Mask user)
  (39 F.Mask user)
  (40 Dwgs.User user)
  (41 Cmts.User user)
  (42 Eco1.User user)
  (43 Eco2.User user)
  (44 Edge.Cuts user)
  (45 Margin user)
  (46 B.CrtYd user)
  (47 F.CrtYd user)
  (48 B.Fab user hide)
  (49 F.Fab user hide)
)

${outputObjs.map(encodeObject).join('\n')}
)
`;
  return output;
}
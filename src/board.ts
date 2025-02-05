import { flatten, IParentTransform, kiAngle, kiAt, kiCoords, kiUnits, rotate } from './common';
import { IEasyEDABoard } from './easyeda-types';
import { encodeObject, ISpectraList } from './spectra';
import { computeArc } from './svg-arc';

// doc: https://docs.easyeda.com/en/DocumentFormat/3-EasyEDA-PCB-File-Format/index.html#shapes

interface IConversionState {
  nets: string[];
  innerLayers: number;
}

function getLayerName(id: string, conversionState: IConversionState) {
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
    11: 'Edge.Cuts',
    12: 'Cmts.User',
    13: 'F.Fab',
    14: 'B.Fab',
    15: 'Dwgs.User',
  };
  if (id in layers) {
    return layers[id];
  }

  // Inner layers: 21 -> In1.Cu
  const intId = parseInt(id, 10);
  if (intId >= 21 && intId <= 50) {
    const innerLayerId = intId - 20;
    conversionState.innerLayers = Math.max(conversionState.innerLayers, innerLayerId);
    return `In${innerLayerId}.Cu`;
  }

  if (intId >= 99 && intId < 200) {
    console.warn(`Warning: unsupported layer id: ${intId}`);
    return null;
  }

  throw new Error(`Missing layer id: ${id}`);
}

function kiStartEnd(
  startX: string,
  startY: string,
  endX: string,
  endY: string,
  parentCoords?: IParentTransform
) {
  const start = kiCoords(startX, startY, parentCoords);
  const end = kiCoords(endX, endY, parentCoords);
  return [
    ['start', start.x, start.y],
    ['end', end.x, end.y],
  ];
}

function isCopper(layerName: string) {
  return layerName.endsWith('.Cu');
}

function getNetId({ nets }: IConversionState, netName: string) {
  if (!netName) {
    return -1;
  }
  const index = nets.indexOf(netName);
  if (index >= 0) {
    return index;
  }
  nets.push(netName);
  return nets.length - 1;
}

function convertVia(
  args: string[],
  conversionState: IConversionState,
  parentCoords?: IParentTransform
) {
  const [x, y, diameter, net, drill, id, locked] = args;
  return [
    'via',
    kiAt(x, y, undefined, parentCoords),
    ['size', kiUnits(diameter)],
    ['drill', kiUnits(drill) * 2],
    ['layers', 'F.Cu', 'B.Cu'],
    ['net', getNetId(conversionState, net)],
  ];
}

function convertPadToVia(
  args: string[],
  conversionState: IConversionState,
  parentCoords?: IParentTransform
) {
  const [
    shape,
    x,
    y,
    holeRadius,
    height,
    layerId,
    net,
    num,
    drill,
    points,
    rotation,
    id,
    holeLength,
    holePoints,
    plated,
    locked,
  ] = args;

  const size = kiUnits(holeRadius);
  const drillHoleLength = holeLength === '0' ? null : kiUnits(holeLength);

  if (shape !== 'ELLIPSE') {
    return [
      'module',
      'AutoGenerated:Pad_' + size.toFixed(2) + 'mm',
      locked === '1' ? 'locked' : null,
      ['layer', 'F.Cu'],
      kiAt(x, y),
      ['attr', 'virtual'],
      ['fp_text', 'reference', '', ['at', 0, 0], ['layer', 'F.SilkS']],
      ['fp_text', 'value', '', ['at', 0, 0], ['layer', 'F.SilkS']],
      convertPad(args, conversionState, { ...kiCoords(x, y), angle: 0 }),
    ];
  }

  return [
    'via',
    kiAt(x, y, undefined, parentCoords),
    ['size', kiUnits(holeRadius)],
    ['drill', kiUnits(drill) * 2],
    ['layers', 'F.Cu', 'B.Cu'],
    ['net', getNetId(conversionState, net)],
  ];
}

function convertTrack(
  args: string[],
  conversionState: IConversionState,
  objName = 'segment',
  parentCoords?: IParentTransform
) {
  const [width, layer, net, coords, id, locked] = args;
  const netId = getNetId(conversionState, net);
  const coordList = coords.split(' ');
  const result = [];
  const layerName = getLayerName(layer, conversionState);
  if (!layerName) {
    return [];
  }

  const lineType = objName === 'segment' && !isCopper(layerName) ? 'gr_line' : objName;
  for (let i = 0; i < coordList.length - 2; i += 2) {
    result.push([
      lineType,
      ...kiStartEnd(
        coordList[i],
        coordList[i + 1],
        coordList[i + 2],
        coordList[i + 3],
        parentCoords
      ),
      ['width', kiUnits(width)],
      ['layer', layerName],
      isCopper(layerName) && netId > 0 ? ['net', netId] : null,
      locked === '1' ? ['status', 40000] : null,
    ]);
  }
  return result;
}

function textLayer(
  layer: string,
  conversionState: IConversionState,
  footprint: boolean,
  isName: boolean
) {
  const layerName = getLayerName(layer, conversionState);
  if (layerName && footprint && isName) {
    return layerName.replace('.SilkS', '.Fab');
  } else {
    return layerName;
  }
}

function convertText(
  args: string[],
  conversionState: IConversionState,
  objName = 'gr_text',
  parentCoords?: IParentTransform
) {
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
    locked,
  ] = args;
  const layerName = textLayer(layer, conversionState, objName === 'fp_text', type === 'N');
  if (!layerName) {
    return null;
  }

  const fontTable: { [key: string]: { width: number; height: number; thickness: number } } = {
    'NotoSerifCJKsc-Medium': { width: 0.8, height: 0.8, thickness: 0.3 },
    'NotoSansCJKjp-DemiLight': { width: 0.6, height: 0.6, thickness: 0.5 },
  };
  const fontMultiplier =
    font in fontTable ? fontTable[font] : { width: 0.9, height: 1, thickness: 0.9 };
  const actualFontWidth = kiUnits(fontSize) * fontMultiplier.width;
  const actualFontHeight = kiUnits(fontSize) * fontMultiplier.height;

  const parsedAngle = parseFloat(angle);
  const parentAngle = parentCoords?.angle ?? 0;
  const xOffset = 0.5 * -1.28 - 1.5 * 1.28 * Math.sin((Math.PI * parsedAngle) / 180);
  const yOffset = 1.5 * -1.28 + 2.54 * Math.sin((Math.PI * parsedAngle) / 180);

  return [
    objName,
    objName === 'fp_text' ? (type === 'P' ? 'reference' : 'value') : null,
    text,
    kiAt(parseFloat(x) + xOffset, parseFloat(y) + yOffset, angle, parentCoords),
    ['layer', layerName],
    display === 'none' ? 'hide' : null,
    [
      'effects',
      [
        'font',
        ['size', actualFontHeight, actualFontWidth],
        ['thickness', kiUnits(lineWidth) * fontMultiplier.thickness],
      ],
      ['justify', 'left', layerName[0] === 'B' ? 'mirror' : null],
    ],
  ];
}

function convertArc(
  args: string[],
  conversionState: IConversionState,
  objName = 'gr_arc',
  transform?: IParentTransform
) {
  const [width, layer, net, path, _, id, locked] = args;
  const layerName = getLayerName(layer, conversionState);
  if (!layerName) {
    return null;
  }
  const pathMatch = /^M\s*([-\d.\s]+)A\s*([-\d.\s]+)$/.exec(path.replace(/[,\s]+/g, ' '));
  if (!pathMatch) {
    console.warn(`Invalid arc path: ${path}`);
    return null;
  }
  const [match, startPoint, arcParams] = pathMatch;
  const [startX, startY] = startPoint.split(' ');
  const [svgRx, svgRy, xAxisRotation, largeArc, sweep, endX, endY] = arcParams.split(' ');
  const start = kiCoords(startX, startY, transform);
  const end = kiCoords(endX, endY, transform);
  const { x: rx, y: ry } = rotate({ x: kiUnits(svgRx), y: kiUnits(svgRy) }, transform?.angle || 0);
  const { cx, cy, extent } = computeArc(
    start.x,
    start.y,
    rx,
    ry,
    parseFloat(xAxisRotation),
    largeArc === '1',
    sweep === '1',
    end.x,
    end.y
  );
  const endPoint = sweep === '1' ? start : end;
  if (isNaN(cx) || isNaN(cy)) {
    console.warn(`Invalid arc: ${path}`);
    return null;
  }
  return [
    objName,
    ['start', cx, cy], // actually center
    ['end', endPoint.x, endPoint.y],
    ['angle', Math.abs(extent)],
    ['width', kiUnits(width)],
    ['layer', layerName],
  ];
}

function getDrill(holeRadius: number, holeLength: number) {
  if (holeRadius && holeLength) {
    return ['drill', 'oval', holeRadius * 2, holeLength];
  }
  if (holeRadius) {
    return ['drill', holeRadius * 2];
  }
  return null;
}

function isRectangle(points: number[]) {
  if (points.length !== 8) {
    return false;
  }

  const eq = (a: number, b: number) => Math.abs(a - b) < 0.01;

  const [x1, y1, x2, y2, x3, y3, x4, y4] = points;
  return (
    (eq(x1, x2) && eq(y2, y3) && eq(x3, x4) && eq(y4, y1)) ||
    (eq(y1, y2) && eq(x2, x3) && eq(y3, y4) && eq(x4, x1))
  );
}

function rectangleSize(points: number[], rotation: number) {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = points;
  const width = Math.max(x1, x2, x3, x4) - Math.min(x1, x2, x3, x4);
  const height = Math.max(y1, y2, y3, y4) - Math.min(y1, y2, y3, y4);
  return Math.round(Math.abs(rotation)) % 180 === 90 ? [height, width] : [width, height];
}

function convertPad(
  args: string[],
  conversionState: IConversionState,
  transform: IParentTransform
) {
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
    rotation,
    id,
    holeLength,
    holePoints,
    plated,
    locked,
  ] = args;

  const padShapes: { [key: string]: string } = {
    ELLIPSE: 'circle',
    RECT: 'rect',
    OVAL: 'oval',
    POLYGON: 'custom',
  };
  const centerCoords = kiCoords(x, y);
  const polygonTransform: IParentTransform = {
    x: centerCoords.x,
    y: centerCoords.y,
    angle: parseFloat(rotation),
  };
  const pointList = points.split(' ').map(parseFloat);
  const pointsAreRectangle = padShapes[shape] === 'custom' && isRectangle(pointList);
  const actualShape = pointsAreRectangle ? 'RECT' : shape;
  const isCustomShape = padShapes[actualShape] === 'custom';
  if (isCustomShape && !points.length) {
    console.warn(`PAD ${id} is a polygon, but has no points defined`);
    return null;
  }

  const netId = getNetId(conversionState, net);
  const layers: { [key: string]: string[] } = {
    1: ['F.Cu', 'F.Paste', 'F.Mask'],
    2: ['B.Cu', 'B.Paste', 'B.Mask'],
    11: ['*.Cu', '*.Mask'],
  };
  const [actualWidth, actualHeight] = pointsAreRectangle
    ? rectangleSize(pointList, parseFloat(rotation))
    : [parseFloat(width), parseFloat(height)];
  const padNum = parseInt(num, 10);

  let realWidth = actualWidth;
  let realHeight = actualHeight;
  let realRotation = parseFloat(rotation);
  if (realWidth > realHeight) {
    realWidth = realHeight;
    realHeight = actualWidth;
    realRotation = realRotation - 90;
  }

  return [
    'pad',
    isNaN(padNum) ? num : padNum,
    kiUnits(holeRadius) > 0 ? 'thru_hole' : 'smd',
    padShapes[actualShape],
    kiAt(x, y, realRotation, transform),
    ['size', Math.max(kiUnits(realWidth), 0.01), Math.max(kiUnits(realHeight), 0.01)],
    ['layers', ...layers[layerId]],
    getDrill(kiUnits(holeRadius), kiUnits(holeLength)),
    netId > 0 ? ['net', netId, net] : null,
    isCustomShape
      ? [
          'primitives',
          [
            'gr_poly',
            ['pts', ...pointListToPolygon(points.split(' '), polygonTransform)],
            ['width', 0.1],
          ],
        ]
      : null,
  ];
}

function convertLibHole(args: string[], transform: IParentTransform) {
  const [x, y, radius, id, locked] = args;
  const size = kiUnits(radius) * 2;
  return [
    'pad',
    '',
    'np_thru_hole',
    'circle',
    kiAt(x, y, undefined, transform),
    ['size', size, size],
    ['drill', size],
    ['layers', '*.Cu', '*.Mask'],
  ];
}

function convertCircle(
  args: string[],
  conversionState: IConversionState,
  type = 'gr_circle',
  parentCoords?: IParentTransform
) {
  const [x, y, radius, strokeWidth, layer, id, locked] = args;
  const layerName = getLayerName(layer, conversionState);
  if (!layerName) {
    return null;
  }
  const center = kiCoords(x, y, parentCoords);
  return [
    type,
    ['center', center.x, center.y],
    ['end', center.x + kiUnits(radius), center.y],
    ['layer', layerName],
    ['width', kiUnits(strokeWidth)],
  ];
}

function pointListToPolygon(points: string[], parentCoords?: IParentTransform) {
  const polygonPoints = [];
  for (let i = 0; i < points.length; i += 2) {
    const coords = kiCoords(points[i], points[i + 1], parentCoords);
    polygonPoints.push(['xy', coords.x, coords.y]);
  }
  return polygonPoints;
}

function pathToPolygon(path: string, parentCoords?: IParentTransform) {
  if (path.indexOf('A') >= 0) {
    console.warn('Warning: SOLIDREGION with arcs/circles are not supported yet!');
    return null;
  }
  const points = path.split(/[ ,LM]/).filter((p) => !isNaN(parseFloat(p)));
  return pointListToPolygon(points, parentCoords);
}

function convertPolygon(
  args: string[],
  conversionState: IConversionState,
  parentCoords?: IParentTransform
) {
  const [layerId, net, path, type, id, , , locked] = args;
  if (type !== 'solid') {
    console.warn(`Warning: unsupported SOLIDREGION type in footprint: ${type}`);
    return null;
  }
  const layerName = getLayerName(layerId, conversionState);
  if (!layerName) {
    return null;
  }
  const polygonPoints = pathToPolygon(path, parentCoords);
  if (!polygonPoints) {
    return null;
  }
  return ['fp_poly', ['pts', ...polygonPoints], ['layer', layerName], ['width', 0]];
}

function convertLib(args: string[], conversionState: IConversionState) {
  const [x, y, attributes, rotation, importFlag, id, , , , locked] = args;
  const shapeList = args.join('~').split('#@$').slice(1);
  const attrList = attributes.split('`');
  const attrs: { [key: string]: string } = {};
  for (let i = 0; i < attrList.length; i += 2) {
    attrs[attrList[i]] = attrList[i + 1];
  }
  const shapes = [];
  const transform = { ...kiCoords(x, y), angle: kiAngle(rotation) };
  for (const shape of shapeList) {
    const [type, ...shapeArgs] = shape.split('~');
    if (type === 'TRACK') {
      shapes.push(...convertTrack(shapeArgs, conversionState, 'fp_line', transform));
    } else if (type === 'TEXT') {
      shapes.push(convertText(shapeArgs, conversionState, 'fp_text', transform));
    } else if (type === 'ARC') {
      shapes.push(convertArc(shapeArgs, conversionState, 'fp_arc', transform));
    } else if (type === 'HOLE') {
      shapes.push(convertLibHole(shapeArgs, transform));
    } else if (type === 'PAD') {
      shapes.push(convertPad(shapeArgs, conversionState, transform));
    } else if (type === 'CIRCLE') {
      shapes.push(convertCircle(shapeArgs, conversionState, 'fp_circle', transform));
    } else if (type === 'SOLIDREGION') {
      shapes.push(convertPolygon(shapeArgs, conversionState, transform));
    } else {
      console.warn(`Warning: unsupported shape ${type} in footprint ${id}`);
    }
  }
  shapes.push([
    'fp_text',
    'user',
    id,
    ['at', 0, 0],
    ['layer', 'Cmts.User'],
    ['effects', ['font', ['size', 1, 1], ['thickness', 0.15]]],
  ]);

  const modAttrs = [];
  const isSmd = shapes.some((shape) => shape && shape[0] === 'pad' && shape[2] === 'smd');
  if (isSmd) {
    modAttrs.push(['attr', 'smd']);
  }

  const footprintName = `easyeda:${attrs.package || id}`;
  return [
    'module',
    footprintName,
    locked === '1' ? 'locked' : null,
    ['layer', 'F.Cu'],
    kiAt(x, y, rotation),
    ...modAttrs,
    ...shapes,
  ];
}

function convertCopperArea(args: string[], conversionState: IConversionState) {
  const [
    strokeWidth,
    layerId,
    net,
    path,
    clearanceWidth,
    fillStyle,
    id,
    thermal,
    keepIsland,
    copperZone,
    locked,
  ] = args;
  const netId = getNetId(conversionState, net);
  const layerName = getLayerName(layerId, conversionState);
  if (!layerName) {
    return null;
  }
  // fill style: solid/none
  // id: gge27
  // thermal: spoke/direct
  const pointList = path.split(/[ ,LM]/).filter((p) => !isNaN(parseFloat(p)));
  const polygonPoints = [];
  for (let i = 0; i < pointList.length; i += 2) {
    const coords = kiCoords(pointList[i], pointList[i + 1]);
    polygonPoints.push(['xy', coords.x, coords.y]);
  }
  return [
    'zone',
    ['net', netId],
    ['net_name', net],
    ['layer', layerName],
    ['hatch', 'edge', 0.508],
    ['connect_pads', ['clearance', kiUnits(clearanceWidth)]],
    // TODO (min_thickness 0.254)
    // TODO (fill yes (arc_segments 32) (thermal_gap 0.508) (thermal_bridge_width 0.508))
    ['polygon', ['pts', ...polygonPoints]],
  ];
}

function convertSolidRegion(args: string[], conversionState: IConversionState) {
  const [layerId, net, path, type, id, locked] = args;
  const layerName = getLayerName(layerId, conversionState);
  if (!layerName) {
    return null;
  }
  const polygonPoints = pathToPolygon(path);
  const netId = getNetId(conversionState, net);
  if (!polygonPoints) {
    return null;
  }
  switch (type) {
    case 'cutout':
      return [
        'zone',
        ['net', netId],
        ['net_name', ''],
        ['hatch', 'edge', 0.508],
        ['layer', layerName],
        ['keepout', ['tracks', 'allowed'], ['vias', 'allowed'], ['copperpour', 'not_allowed']],
        ['polygon', ['pts', ...polygonPoints]],
      ];

    case 'solid':
    case 'npth':
      return [
        'gr_poly',
        // Unfortunately, KiCad does not support net for gr_poly
        // ['net', netId],
        ['pts', ...polygonPoints],
        ['layer', layerName],
        ['width', 0],
      ];

    default:
      console.warn(`Warning: unsupported SOLIDREGION type ${type}`);
      return null;
  }
}

function convertHole(args: string[]) {
  const [x, y, radius, id, locked] = args;
  const size = kiUnits(radius) * 2;
  return [
    'module',
    `AutoGenerated:MountingHole_${size.toFixed(2)}mm`,
    locked === '1' ? 'locked' : null,
    ['layer', 'F.Cu'],
    kiAt(x, y),
    ['attr', 'virtual'],
    ['fp_text', 'reference', '', ['at', 0, 0], ['layer', 'F.SilkS']],
    ['fp_text', 'value', '', ['at', 0, 0], ['layer', 'F.SilkS']],
    [
      'pad',
      '',
      'np_thru_hole',
      'circle',
      ['at', 0, 0],
      ['size', size, size],
      ['drill', size],
      ['layers', '*.Cu', '*.Mask'],
    ],
  ];
}

export function convertShape(shape: string, conversionState: IConversionState) {
  const [type, ...args] = shape.split('~');
  switch (type) {
    case 'VIA':
      return [convertVia(args, conversionState)];
    case 'TRACK':
      return convertTrack(args, conversionState);
    case 'TEXT':
      return [convertText(args, conversionState)];
    case 'ARC':
      return [convertArc(args, conversionState)];
    case 'COPPERAREA':
      return [convertCopperArea(args, conversionState)];
    case 'SOLIDREGION':
      return [convertSolidRegion(args, conversionState)];
    case 'CIRCLE':
      return [convertCircle(args, conversionState)];
    case 'HOLE':
      return [convertHole(args)];
    case 'LIB':
      return [convertLib(args, conversionState)];
    case 'PAD':
      return [convertPadToVia(args, conversionState)];
    default:
      console.warn(`Warning: unsupported shape ${type}`);
      return null;
  }
}

export async function convertBoardToArray(input: IEasyEDABoard): Promise<ISpectraList> {
  const { nets } = input.routerRule || { nets: [] as string[] };
  const conversionState = { nets, innerLayers: 0 };
  nets.unshift(''); // Kicad expects net 0 to be empty
  const shapes = flatten(
    await Promise.all(input.shape.map(async (shape) => convertShape(shape, conversionState)))
  );
  const outputObjs = [...nets.map((net, idx) => ['net', idx, net]), ...shapes].filter(
    (obj) => obj != null
  );

  const innerLayers = [];
  for (let i = 1; i <= conversionState.innerLayers; i++) {
    innerLayers.push([i, `In${i}.Cu`, 'signal']);
  }

  const layers = [
    [0, 'F.Cu', 'signal'],
    ...innerLayers,
    [31, 'B.Cu', 'signal'],
    [32, 'B.Adhes', 'user'],
    [33, 'F.Adhes', 'user'],
    [34, 'B.Paste', 'user'],
    [35, 'F.Paste', 'user'],
    [36, 'B.SilkS', 'user'],
    [37, 'F.SilkS', 'user'],
    [38, 'B.Mask', 'user'],
    [39, 'F.Mask', 'user'],
    [40, 'Dwgs.User', 'user'],
    [41, 'Cmts.User', 'user'],
    [42, 'Eco1.User', 'user'],
    [43, 'Eco2.User', 'user'],
    [44, 'Edge.Cuts', 'user'],
    [45, 'Margin', 'user'],
    [46, 'B.CrtYd', 'user'],
    [47, 'F.CrtYd', 'user'],
    [48, 'B.Fab', 'user', 'hide'],
    [49, 'F.Fab', 'user', 'hide'],
  ];

  return [
    'kicad_pcb',
    ['version', 20171130],
    ['host', 'pcbnew', '(5.1.5)-3'],
    ['page', 'A4'],
    ['layers', ...layers],
    ...outputObjs,
  ];
}

export async function convertBoard(board: IEasyEDABoard) {
  return encodeObject(await convertBoardToArray(board));
}

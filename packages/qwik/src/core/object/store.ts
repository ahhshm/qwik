import { assertDefined, assertTrue } from '../assert/assert';
import { assertQrl, isQrl } from '../import/qrl-class';
import { getContext, QContext, tryGetContext } from '../props/props';
import { getDocument } from '../util/dom';
import { isDocument, isElement, isNode, isQwikElement, isVirtualElement } from '../util/element';
import { logDebug, logWarn } from '../util/log';
import { ELEMENT_ID, ELEMENT_ID_PREFIX, QContainerAttr, QStyle } from '../util/markers';
import { qDev } from '../util/qdev';
import {
  createProxy,
  getOrCreateProxy,
  getProxyFlags,
  getProxyTarget,
  isConnected,
  isMutable,
  mutable,
  shouldSerialize,
} from './q-object';
import {
  destroyWatch,
  Subscriber,
  SubscriberDescriptor,
  WatchFlagsIsDirty,
} from '../use/use-watch';
import type { QRL } from '../import/qrl.public';
import { emitEvent } from '../util/event';
import {
  qError,
  QError_containerAlreadyPaused,
  QError_missingObjectId,
  QError_verifySerializable,
} from '../error/error';
import { isArray, isObject, isSerializableObject, isString } from '../util/types';
import { directGetAttribute, directSetAttribute } from '../render/fast-calls';
import { isNotNullable, isPromise } from '../util/promises';
import { isResourceReturn } from '../use/use-resource';
import { createParser, Parser, serializeValue, UNDEFINED_PREFIX } from './serializers';
import { ContainerState, getContainerState } from '../render/container';
import { getQId } from '../render/execute-component';
import { processVirtualNodes, QwikElement } from '../render/dom/virtual-element';
import { getDomListeners } from '../props/props-on';

export type GetObject = (id: string) => any;
export type GetObjID = (obj: any) => string | null;

// <docs markdown="../readme.md#pauseContainer">
// !!DO NOT EDIT THIS COMMENT DIRECTLY!!!
// (edit ../readme.md#pauseContainer instead)
/**
 * Serialize the current state of the application into DOM
 *
 * @alpha
 */
// </docs>
export const pauseContainer = async (
  elmOrDoc: Element | Document,
  defaultParentJSON?: Element
): Promise<SnapshotResult> => {
  const doc = getDocument(elmOrDoc);
  const documentElement = doc.documentElement;
  const containerEl = isDocument(elmOrDoc) ? documentElement : elmOrDoc;
  if (directGetAttribute(containerEl, QContainerAttr) === 'paused') {
    throw qError(QError_containerAlreadyPaused);
  }
  const parentJSON =
    defaultParentJSON ?? (containerEl === doc.documentElement ? doc.body : containerEl);
  const data = await pauseFromContainer(containerEl);
  const script = doc.createElement('script');
  directSetAttribute(script, 'type', 'qwik/json');
  script.textContent = escapeText(JSON.stringify(data.state, undefined, qDev ? '  ' : undefined));
  parentJSON.appendChild(script);
  directSetAttribute(containerEl, QContainerAttr, 'paused');
  return data;
};

export const moveStyles = (containerEl: Element, containerState: ContainerState) => {
  const head = containerEl.ownerDocument.head;
  containerEl.querySelectorAll('style[q\\:style]').forEach((el) => {
    containerState.$styleIds$.add(el.getAttribute(QStyle)!);
    head.appendChild(el);
  });
};

export const resumeContainer = (containerEl: Element) => {
  if (!isContainer(containerEl)) {
    logWarn('Skipping hydration because parent element is not q:container');
    return;
  }
  const doc = getDocument(containerEl);
  const isDocElement = containerEl === doc.documentElement;
  const parentJSON = isDocElement ? doc.body : containerEl;
  const script = getQwikJSON(parentJSON);
  if (!script) {
    logWarn('Skipping hydration qwik/json metadata was not found.');
    return;
  }
  script.remove();

  const containerState = getContainerState(containerEl);
  moveStyles(containerEl, containerState);
  const meta = JSON.parse(unescapeText(script.textContent || '{}')) as SnapshotState;

  // Collect all elements
  const elements = new Map<string, QwikElement>();

  const getObject: GetObject = (id) => {
    return getObjectImpl(id, elements, meta.objs, containerState);
  };

  let maxId = 0;
  getNodesInScope(containerEl, hasQId).forEach((el) => {
    const id = directGetAttribute(el, ELEMENT_ID);
    assertDefined(id, `resume: element missed q:id`, el);
    const ctx = getContext(el);
    ctx.$id$ = id;
    ctx.$mounted$ = true;
    elements.set(ELEMENT_ID_PREFIX + id, el);
    maxId = Math.max(maxId, strToInt(id));
  });
  containerState.$elementIndex$ = ++maxId;

  const parser = createParser(getObject, containerState, doc);

  // Revive proxies with subscriptions into the proxymap
  reviveValues(meta.objs, meta.subs, getObject, containerState, parser);

  // Rebuild target objects
  for (const obj of meta.objs) {
    reviveNestedObjects(obj, getObject, parser);
  }

  Object.entries(meta.ctx).forEach(([elementID, ctxMeta]) => {
    const el = getObject(elementID) as QwikElement;
    assertDefined(el, `resume: cant find dom node for id`, elementID);
    const ctx = getContext(el);
    const qobj = ctxMeta.r;
    const seq = ctxMeta.s;
    const host = ctxMeta.h;
    const contexts = ctxMeta.c;
    const watches = ctxMeta.w;

    if (qobj) {
      assertTrue(isElement(el), 'el must be an actual DOM element');
      ctx.$refMap$.push(...qobj.split(' ').map((part) => getObject(part)));
      ctx.$listeners$ = getDomListeners(el as any);
    }
    if (seq) {
      ctx.$seq$ = seq.split(' ').map((part) => getObject(part));
    }
    if (watches) {
      ctx.$watches$ = watches.split(' ').map((part) => getObject(part));
    }
    if (contexts) {
      contexts.split(' ').map((part) => {
        const [key, value] = part.split('=');
        if (!ctx.$contexts$) {
          ctx.$contexts$ = new Map();
        }
        ctx.$contexts$.set(key, getObject(value));
      });
    }

    // Restore sequence scoping
    if (host) {
      const [props, renderQrl] = host.split(' ');
      assertDefined(props, `resume: props missing in host metadata`, host);
      assertDefined(renderQrl, `resume: renderQRL missing in host metadata`, host);
      ctx.$props$ = getObject(props);
      ctx.$renderQrl$ = getObject(renderQrl);
    }
  });

  directSetAttribute(containerEl, QContainerAttr, 'resumed');
  logDebug('Container resumed');
  emitEvent(containerEl, 'qresume', undefined, true);
};

/**
 * @alpha
 */
export interface SnapshotMetaValue {
  r?: string; // q:obj
  w?: string; // q:watches
  s?: string; // q:seq
  h?: string; // q:host
  c?: string; // q:context
}

/**
 * @alpha
 */
export type SnapshotMeta = Record<string, SnapshotMetaValue>;

/**
 * @alpha
 */
export interface SnapshotState {
  ctx: SnapshotMeta;
  objs: any[];
  subs: any[];
}

/**
 * @alpha
 */
export interface SnapshotListener {
  key: string;
  qrl: QRL<any>;
  el: Element;
}

/**
 * @alpha
 */
export interface SnapshotResult {
  state: SnapshotState;
  listeners: SnapshotListener[];
  objs: any[];
  mode: 'render' | 'listeners' | 'static';
  pendingContent: Promise<string>[];
}

export const pauseFromContainer = async (containerEl: Element): Promise<SnapshotResult> => {
  const containerState = getContainerState(containerEl);
  const contexts = getNodesInScope(containerEl, hasQId).map(tryGetContext) as QContext[];
  return _pauseFromContexts(contexts, containerState);
};

/**
 * @internal
 */
export const _pauseFromContexts = async (
  elements: QContext[],
  containerState: ContainerState
): Promise<SnapshotResult> => {
  const elementToIndex = new Map<QwikElement, string | null>();
  const collector = createCollector(containerState);
  const listeners: SnapshotListener[] = [];
  for (const ctx of elements) {
    const el = ctx.$element$;
    if (ctx.$listeners$ && isElement(el)) {
      ctx.$listeners$.forEach((qrls, key) => {
        qrls.forEach((qrl) => {
          listeners.push({
            key,
            qrl,
            el,
          });
        });
      });
    }
    for (const watch of ctx.$watches$) {
      collector.$watches$.push(watch);
    }
  }

  // No listeners implies static page
  if (listeners.length === 0) {
    return {
      state: {
        ctx: {},
        objs: [],
        subs: [],
      },
      objs: [],
      listeners: [],
      pendingContent: [],
      mode: 'static',
    };
  }

  // Listeners becomes the app roots
  for (const listener of listeners) {
    assertQrl(listener.qrl);
    const captured = listener.qrl.$captureRef$;
    if (captured) {
      for (const obj of captured) {
        await collectValue(obj, collector, true);
      }
    }
    const ctx = tryGetContext(listener.el)!;
    for (const obj of ctx.$refMap$) {
      await collectValue(obj, collector, true);
    }
  }

  // If at this point any component can render, we need to capture Context and Props
  const canRender = collector.$elements$.length > 0;
  if (canRender) {
    for (const ctx of elements) {
      await collectProps(ctx.$element$, ctx.$props$, collector);

      if (ctx.$contexts$) {
        for (const item of ctx.$contexts$.values()) {
          await collectValue(item, collector, false);
        }
      }
    }
  }

  // Convert objSet to array
  const objs = Array.from(new Set(collector.$objMap$.values()));

  const objToId = new Map<any, number>();

  const getElementID = (el: QwikElement): string | null => {
    let id = elementToIndex.get(el);
    if (id === undefined) {
      if (el.isConnected) {
        id = getQId(el);
        if (!id) {
          console.warn('Missing ID', el);
        } else {
          id = ELEMENT_ID_PREFIX + id;
        }
      } else {
        id = null;
      }
      elementToIndex.set(el, id);
    }
    return id;
  };

  const getObjId = (obj: any): string | null => {
    let suffix = '';
    if (isMutable(obj)) {
      obj = obj.v;
      suffix = '%';
    }
    if (isPromise(obj)) {
      const { value, resolved } = getPromiseValue(obj);
      obj = value;
      if (resolved) {
        suffix += '~';
      } else {
        suffix += '_';
      }
    }
    if (isObject(obj)) {
      const target = getProxyTarget(obj);
      if (target) {
        suffix += '!';
        obj = target;
      }

      if (!target && isQwikElement(obj)) {
        const elID = getElementID(obj as Element);
        if (elID) {
          return elID + suffix;
        }
        return null;
      }
    }
    if (collector.$objMap$.has(obj)) {
      const value = collector.$objMap$.get(obj);
      const id = objToId.get(value);
      assertTrue(typeof id === 'number', 'Can not find ID for object');
      return intToStr(id as any) + suffix;
    }
    return null;
  };

  const mustGetObjId = (obj: any): string => {
    const key = getObjId(obj);
    if (key === null) {
      throw qError(QError_missingObjectId, obj);
    }
    return key;
  };

  // Compute subscriptions
  const subsMap = new Map<
    any,
    { subscriber: Subscriber | '$'; data: string[] | number | null }[]
  >();
  objs.forEach((obj) => {
    const flags = getProxyFlags(containerState.$proxyMap$.get(obj));
    if (flags === undefined) {
      return;
    }
    const subsObj: { subscriber: Subscriber | '$'; data: string[] | number | null }[] = [];
    if (flags > 0) {
      subsObj.push({
        subscriber: '$',
        data: flags,
      });
    }
    const subs = containerState.$subsManager$.$tryGetLocal$(obj)?.$subs$;
    if (subs) {
      subs.forEach((set, key) => {
        if (isQwikElement(key)) {
          if (!collector.$elements$.includes(key)) {
            return;
          }
        }
        subsObj.push({
          subscriber: key,
          data: set ? Array.from(set) : null,
        });
      });
    }
    if (subsObj.length > 0) {
      subsMap.set(obj, subsObj);
    }
  });

  // Sort objects: the ones with subscriptions go first
  objs.sort((a, b) => {
    const isProxyA = subsMap.has(a) ? 0 : 1;
    const isProxyB = subsMap.has(b) ? 0 : 1;
    return isProxyA - isProxyB;
  });

  // Generate object ID by using a monotonic counter
  let count = 0;
  for (const obj of objs) {
    objToId.set(obj, count);
    count++;
  }

  // Serialize object subscriptions
  const subs = objs
    .map((obj) => {
      const sub = subsMap.get(obj);
      if (!sub) {
        return null;
      }
      const subsObj: Record<string, string[] | number | null> = {};
      sub.forEach(({ subscriber, data }) => {
        if (subscriber === '$') {
          subsObj[subscriber] = data;
        } else {
          const id = getObjId(subscriber);
          if (id !== null) {
            subsObj[id] = data;
          }
        }
      });
      return subsObj;
    })
    .filter(isNotNullable);

  // Serialize objects
  const convertedObjs = objs.map((obj) => {
    if (obj === null) {
      return null;
    }
    const typeObj = typeof obj;
    switch (typeObj) {
      case 'undefined':
        return UNDEFINED_PREFIX;
      case 'string':
      case 'number':
      case 'boolean':
        return obj;

      default:
        const value = serializeValue(obj, getObjId, containerState);
        if (value !== undefined) {
          return value;
        }
        if (typeObj === 'object') {
          if (isArray(obj)) {
            return obj.map(mustGetObjId);
          }
          if (isSerializableObject(obj)) {
            const output: Record<string, any> = {};
            Object.entries(obj).forEach(([key, value]) => {
              output[key] = mustGetObjId(value);
            });
            return output;
          }
        }
        break;
    }
    throw qError(QError_verifySerializable, obj);
  });

  const meta: SnapshotMeta = {};

  // Write back to the dom
  elements.forEach((ctx) => {
    const node = ctx.$element$;
    assertDefined(ctx, `pause: missing context for dom node`, node);

    const ref = ctx.$refMap$;
    const props = ctx.$props$;
    const contexts = ctx.$contexts$;
    const watches = ctx.$watches$;
    const renderQrl = ctx.$renderQrl$;
    const seq = ctx.$seq$;
    const metaValue: SnapshotMetaValue = {};
    const elementCaptured = collector.$elements$.includes(node);

    let add = false;
    if (ref.length > 0) {
      const value = ref.map(mustGetObjId).join(' ');
      if (value) {
        metaValue.r = value;
        add = true;
      }
    }

    if (canRender) {
      if (elementCaptured && props) {
        const objs = [props];
        if (renderQrl) {
          objs.push(renderQrl);
        }
        const value = objs.map(mustGetObjId).join(' ');
        if (value) {
          metaValue.h = value;
          add = true;
        }
      }

      if (watches.length > 0) {
        const value = watches.map(getObjId).filter(isNotNullable).join(' ');
        if (value) {
          metaValue.w = value;
          add = true;
        }
      }

      if (elementCaptured && seq.length > 0) {
        const value = seq.map(mustGetObjId).join(' ');
        if (value) {
          metaValue.s = value;
          add = true;
        }
      }

      if (contexts) {
        const serializedContexts: string[] = [];
        contexts.forEach((value, key) => {
          serializedContexts.push(`${key}=${mustGetObjId(value)}`);
        });
        const value = serializedContexts.join(' ');
        if (value) {
          metaValue.c = value;
          add = true;
        }
      }
    }

    if (add) {
      const elementID = getElementID(node);
      assertDefined(elementID, `pause: can not generate ID for dom node`, node);
      meta[elementID] = metaValue;
    }
  });

  const pendingContent: Promise<string>[] = [];
  for (const watch of collector.$watches$) {
    if (qDev) {
      if (watch.$flags$ & WatchFlagsIsDirty) {
        logWarn('Serializing dirty watch. Looks like an internal error.');
      }
      if (!isConnected(watch)) {
        logWarn('Serializing disconneted watch. Looks like an internal error.');
      }
    }
    destroyWatch(watch);
  }

  // Sanity check of serialized element
  if (qDev) {
    elementToIndex.forEach((value, el) => {
      if (!value) {
        logWarn('unconnected element', el.nodeName, '\n');
      }
    });
  }

  return {
    state: {
      ctx: meta,
      objs: convertedObjs,
      subs,
    },
    pendingContent,
    objs,
    listeners,
    mode: canRender ? 'render' : 'listeners',
  };
};

export const getQwikJSON = (parentElm: Element): HTMLScriptElement | undefined => {
  let child = parentElm.lastElementChild;
  while (child) {
    if (child.tagName === 'SCRIPT' && directGetAttribute(child, 'type') === 'qwik/json') {
      return child as HTMLScriptElement;
    }
    child = child.previousElementSibling;
  }
  return undefined;
};

const SHOW_ELEMENT = 1;
const SHOW_COMMENT = 128;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

export const getNodesInScope = (parent: Element, predicate: (el: Node) => boolean) => {
  const nodes: Element[] = [];
  if (predicate(parent)) {
    nodes.push(parent);
  }
  const walker = parent.ownerDocument.createTreeWalker(parent, SHOW_ELEMENT | SHOW_COMMENT, {
    acceptNode(node) {
      if (isContainer(node)) {
        return FILTER_REJECT;
      }
      return predicate(node) ? FILTER_ACCEPT : FILTER_SKIP;
    },
  });
  const pars: QwikElement[] = [];
  let currentNode: Node | null = null;
  while ((currentNode = walker.nextNode())) {
    pars.push(processVirtualNodes(currentNode) as Element);
  }
  return pars;
};

const reviveValues = (
  objs: any[],
  subs: any[],
  getObject: GetObject,
  containerState: ContainerState,
  parser: Parser
) => {
  for (let i = 0; i < objs.length; i++) {
    const value = objs[i];
    if (isString(value)) {
      objs[i] = value === UNDEFINED_PREFIX ? undefined : parser.prepare(value);
    }
  }
  for (let i = 0; i < subs.length; i++) {
    const value = objs[i];
    const sub = subs[i];
    if (sub) {
      const converted = new Map();
      let flags = 0;
      Object.entries(sub).forEach((entry) => {
        if (entry[0] === '$') {
          flags = entry[1] as number;
          return;
        }
        const el = getObject(entry[0]);
        if (!el) {
          logWarn('QWIK can not revive subscriptions because of missing element ID', entry, value);
          return;
        }
        const set = entry[1] === null ? null : (new Set(entry[1] as any) as Set<string>);
        converted.set(el, set);
      });
      createProxy(value, containerState, flags, converted);
    }
  }
};

const reviveNestedObjects = (obj: any, getObject: GetObject, parser: Parser) => {
  if (parser.fill(obj)) {
    return;
  }

  if (obj && typeof obj == 'object') {
    if (isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const value = obj[i];
        if (typeof value == 'string') {
          obj[i] = getObject(value);
        } else {
          reviveNestedObjects(value, getObject, parser);
        }
      }
    } else if (isSerializableObject(obj)) {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const value = obj[key];
          if (typeof value == 'string') {
            obj[key] = getObject(value);
          } else {
            reviveNestedObjects(value, getObject, parser);
          }
        }
      }
    }
  }
};

const OBJECT_TRANSFORMS: Record<string, (obj: any, containerState: ContainerState) => any> = {
  '!': (obj: any, containerState: ContainerState) => {
    return containerState.$proxyMap$.get(obj) ?? getOrCreateProxy(obj, containerState);
  },
  '%': (obj: any) => {
    return mutable(obj);
  },
  '~': (obj: any) => {
    return Promise.resolve(obj);
  },
  _: (obj: any) => {
    return Promise.reject(obj);
  },
};

const getObjectImpl = (
  id: string,
  elements: Map<string, QwikElement>,
  objs: any[],
  containerState: ContainerState
) => {
  assertTrue(
    typeof id === 'string' && id.length > 0,
    'resume: id must be an non-empty string, got:',
    id
  );

  if (id.startsWith(ELEMENT_ID_PREFIX)) {
    assertTrue(elements.has(id), `missing element for id:`, id);
    return elements.get(id);
  }
  const index = strToInt(id);
  assertTrue(objs.length > index, 'resume: index is out of bounds', id);
  let obj = objs[index];
  for (let i = id.length - 1; i >= 0; i--) {
    const code = id[i];
    const transform = OBJECT_TRANSFORMS[code];
    if (!transform) {
      break;
    }
    obj = transform(obj, containerState);
  }
  return obj;
};

const collectProps = async (el: QwikElement, props: any, collector: Collector) => {
  const subs = collector.$containerState$.$subsManager$.$tryGetLocal$(
    getProxyTarget(props)
  )?.$subs$;
  if (subs && subs.has(el)) {
    // The host element read the props
    await collectElement(el, collector);
  }
};

export interface Collector {
  $seen$: Set<any>;
  $seenLeaks$: Set<any>;
  $objMap$: Map<any, any>;
  $elements$: QwikElement[];
  $watches$: SubscriberDescriptor[];
  $containerState$: ContainerState;
}

const createCollector = (containerState: ContainerState): Collector => {
  return {
    $seen$: new Set(),
    $seenLeaks$: new Set(),
    $objMap$: new Map(),
    $elements$: [],
    $watches$: [],
    $containerState$: containerState,
  };
};

const collectElement = async (el: QwikElement, collector: Collector) => {
  if (collector.$elements$.includes(el)) {
    return;
  }
  const ctx = tryGetContext(el);
  if (ctx) {
    collector.$elements$.push(el);
    if (ctx.$props$) {
      await collectValue(ctx.$props$, collector, false);
    }
    if (ctx.$renderQrl$) {
      await collectValue(ctx.$renderQrl$, collector, false);
    }
    for (const obj of ctx.$seq$) {
      await collectValue(obj, collector, false);
    }
    for (const obj of ctx.$watches$) {
      await collectValue(obj, collector, false);
    }

    if (ctx.$contexts$) {
      for (const obj of ctx.$contexts$.values()) {
        await collectValue(obj, collector, false);
      }
    }
  }
};

export const escapeText = (str: string) => {
  return str.replace(/<(\/?script)/g, '\\x3C$1');
};

export const unescapeText = (str: string) => {
  return str.replace(/\\x3C(\/?script)/g, '<$1');
};

const collectSubscriptions = async (target: any, collector: Collector) => {
  const subs = collector.$containerState$.$subsManager$.$tryGetLocal$(target)?.$subs$;
  if (subs) {
    if (collector.$seen$.has(subs)) {
      return;
    }
    collector.$seen$.add(subs);
    for (const key of Array.from(subs.keys())) {
      if (isVirtualElement(key)) {
        await collectElement(key, collector);
      } else {
        await collectValue(key, collector, true);
      }
    }
  }
};

const PROMISE_VALUE = Symbol();

interface PromiseValue {
  resolved: boolean;
  value: any;
}
const resolvePromise = (promise: Promise<any>) => {
  return promise.then(
    (value) => {
      const v: PromiseValue = {
        resolved: true,
        value,
      };
      (promise as any)[PROMISE_VALUE] = v;
      return value;
    },
    (value) => {
      const v: PromiseValue = {
        resolved: false,
        value,
      };
      (promise as any)[PROMISE_VALUE] = v;
      return value;
    }
  );
};

const getPromiseValue = (promise: Promise<any>): PromiseValue => {
  assertTrue(PROMISE_VALUE in promise, 'pause: promise was not resolved previously', promise);
  return (promise as any)[PROMISE_VALUE];
};

const collectValue = async (obj: any, collector: Collector, leaks: boolean) => {
  const input = obj;
  const seen = leaks ? collector.$seenLeaks$ : collector.$seen$;
  if (seen.has(obj)) {
    return;
  }
  seen.add(obj);

  if (!shouldSerialize(obj) || obj === undefined) {
    collector.$objMap$.set(obj, undefined);
    return;
  }

  if (obj != null) {
    // Handle QRL
    if (isQrl(obj)) {
      collector.$objMap$.set(obj, obj);
      if (obj.$captureRef$) {
        for (const item of obj.$captureRef$) {
          await collectValue(item, collector, leaks);
        }
      }
      return;
    }

    // Handle Objets
    if (typeof obj === 'object') {
      // Handle promises
      if (isPromise(obj)) {
        const value = await resolvePromise(obj);
        await collectValue(value, collector, leaks);
        return;
      }

      const target = getProxyTarget(obj);

      // Handle dom nodes
      if (!target && isNode(obj)) {
        if (isDocument(obj)) {
          collector.$objMap$.set(obj, obj);
        } else if (!isQwikElement(obj)) {
          throw qError(QError_verifySerializable, obj);
        }
        return;
      }

      // If proxy collect subscriptions
      if (target) {
        if (leaks) {
          await collectSubscriptions(target, collector);
        }
        obj = target;
        if (seen.has(obj)) {
          return;
        }
        seen.add(obj);

        if (isResourceReturn(obj)) {
          collector.$objMap$.set(target, target);
          await collectValue(obj.promise, collector, leaks);
          await collectValue(obj.resolved, collector, leaks);
          return;
        }
      }

      collector.$objMap$.set(obj, obj);
      if (isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          await collectValue(input[i], collector, leaks);
        }
      } else {
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            await collectValue(input[key], collector, leaks);
          }
        }
      }
      return;
    }
  }
  collector.$objMap$.set(obj, obj);
};

export const isContainer = (el: Node) => {
  return isElement(el) && el.hasAttribute(QContainerAttr);
};

const hasQId = (el: Node) => {
  const node = processVirtualNodes(el);
  if (isQwikElement(node)) {
    return node.hasAttribute(ELEMENT_ID);
  }
  return false;
};

export const intToStr = (nu: number) => {
  return nu.toString(36);
};

export const strToInt = (nu: string) => {
  return parseInt(nu, 36);
};

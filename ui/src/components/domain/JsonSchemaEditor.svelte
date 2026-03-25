<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { EditorView, basicSetup } from 'codemirror';
  import { Compartment, EditorState } from '@codemirror/state';
  import { gatewaySyncAnnotation } from '$lib/codemirrorAnnotations.js';
  import { json } from '@codemirror/lang-json';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { theme } from '$lib/stores/theme.js';

  interface Props {
    value: string;
    readOnly?: boolean;
    oninput?: (value: string) => void;
    /** Runs after paste (e.g. normalize JSON); content is applied in the same tick. */
    onpaste?: () => void;
    /** Min height of the scroll area (e.g. compact rows in drawers). */
    scrollerMinHeight?: string;
  }

  let {
    value,
    readOnly = false,
    oninput,
    onpaste,
    scrollerMinHeight = '18rem',
  }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined = $state();

  const themeComp = new Compartment();
  const readOnlyComp = new Compartment();

  /** CodeMirror extensions capture callbacks once; keep latest handlers here. */
  const editorCallbacks: {
    oninput?: (value: string) => void;
    onpaste?: () => void;
  } = {};

  $effect(() => {
    editorCallbacks.oninput = oninput;
    editorCallbacks.onpaste = onpaste;
  });

  function lightChrome() {
    return EditorView.theme({
      '&': { height: '100%', fontSize: '12px' },
      '.cm-editor': {
        borderRadius: '0.5rem',
        border: '1px solid rgb(203 213 225)',
        backgroundColor: 'white',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        minHeight: scrollerMinHeight,
      },
      '.cm-content': { padding: '0.5rem 0', caretColor: 'rgb(15 23 42)' },
      '.cm-gutters': {
        backgroundColor: 'rgb(248 250 252)',
        color: 'rgb(148 163 184)',
        borderRight: '1px solid rgb(226 232 240)',
        borderTopLeftRadius: '0.5rem',
        borderBottomLeftRadius: '0.5rem',
      },
      '.cm-activeLineGutter': { backgroundColor: 'rgb(241 245 249)' },
    });
  }

  function darkChrome() {
    return EditorView.theme({
      '&': { height: '100%', fontSize: '12px' },
      '.cm-editor': {
        borderRadius: '0.5rem',
        border: '1px solid rgb(51 65 85)',
        backgroundColor: 'rgb(30 41 59)',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        minHeight: scrollerMinHeight,
      },
      '.cm-content': { padding: '0.5rem 0' },
      '.cm-gutters': {
        backgroundColor: 'rgb(15 23 42 / 0.85)',
        borderRight: '1px solid rgb(51 65 85)',
        borderTopLeftRadius: '0.5rem',
        borderBottomLeftRadius: '0.5rem',
      },
    });
  }

  function darkExtensions() {
    return [oneDark, darkChrome()];
  }

  function baseExtensions(preferDark: boolean) {
    return [
      basicSetup,
      json(),
      EditorView.lineWrapping,
      readOnlyComp.of(EditorState.readOnly.of(readOnly)),
      themeComp.of(preferDark ? darkExtensions() : [lightChrome()]),
      EditorView.domEventHandlers({
        paste: () => {
          requestAnimationFrame(() => editorCallbacks.onpaste?.());
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || !editorCallbacks.oninput) return;
        if (update.transactions.some((tr) => tr.isUserEvent('gateway.sync'))) return;
        editorCallbacks.oninput(update.state.doc.toString());
      }),
    ];
  }

  let unsubTheme: (() => void) | undefined;

  onMount(() => {
    if (!container) return;
    const preferDark = get(theme) === 'dark';
    view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: baseExtensions(preferDark),
      }),
      parent: container,
    });

    unsubTheme = theme.subscribe((t) => {
      if (!view) return;
      const dark = t === 'dark';
      view.dispatch({
        effects: themeComp.reconfigure(dark ? darkExtensions() : [lightChrome()]),
        annotations: gatewaySyncAnnotation,
      });
    });
  });

  onDestroy(() => {
    unsubTheme?.();
    view?.destroy();
    view = undefined;
  });

  $effect(() => {
    const v = value;
    if (!view) return;
    // Editable: parent `value` can lag one flush behind CM while typing.
    if (!readOnly && view.hasFocus) return;
    const current = view.state.doc.toString();
    if (current !== v) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
        annotations: gatewaySyncAnnotation,
      });
    }
  });

  $effect(() => {
    const ro = readOnly;
    if (!view) return;
    view.dispatch({
      effects: readOnlyComp.reconfigure(EditorState.readOnly.of(ro)),
      annotations: gatewaySyncAnnotation,
    });
  });
</script>

<div
  bind:this={container}
  class="json-schema-editor-root w-full"
  style:min-height={scrollerMinHeight}
></div>

<style>
  :global(.json-schema-editor-root .cm-editor) {
    outline: none;
  }
  :global(.json-schema-editor-root .cm-editor.cm-focused) {
    box-shadow: 0 0 0 2px rgb(99 102 241 / 0.35);
  }
  :global(html.dark .json-schema-editor-root .cm-editor.cm-focused) {
    box-shadow: 0 0 0 2px rgb(129 140 248 / 0.35);
  }
</style>

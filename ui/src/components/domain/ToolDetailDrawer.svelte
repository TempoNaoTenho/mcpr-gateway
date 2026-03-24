<script lang="ts">
  import { X } from 'lucide-svelte';
  import Badge from '$components/ui/Badge.svelte';
  import InfoTooltip from '$components/ui/InfoTooltip.svelte';
  import JsonSchemaEditor from '$components/domain/JsonSchemaEditor.svelte';
  import type { ToolRecord } from '$lib/api.js';

  interface Props {
    tool: ToolRecord | null;
    editorText: string;
    descriptionText: string;
    parseError?: string;
    saveDisabled?: boolean;
    saving?: boolean;
    onclose: () => void;
    onEditorInput: (value: string) => void;
    onDescriptionInput: (value: string) => void;
    onsave?: () => void;
    onrevert?: () => void;
  }

  let {
    tool,
    editorText,
    descriptionText,
    parseError = '',
    saveDisabled = false,
    saving = false,
    onclose,
    onEditorInput,
    onDescriptionInput,
    onsave,
    onrevert,
  }: Props = $props();
</script>

{#if tool}
  <div class="fixed inset-0 z-30 bg-black/30" onclick={onclose} role="presentation"></div>

  <aside class="fixed right-0 top-0 bottom-0 z-40 w-[48rem] max-w-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 flex flex-col shadow-xl overflow-hidden">
    <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
      <div>
        <p class="font-semibold text-slate-900 dark:text-white text-sm">Tool customization</p>
        <p class="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">{tool.serverId} / {tool.name}</p>
      </div>
      <button
        onclick={onclose}
        class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <X size={16} />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      <div class="flex items-center gap-2 flex-wrap">
        <Badge variant={tool.customized ? 'warning' : 'muted'}>
          {tool.customized ? 'customized' : 'inherited'}
        </Badge>
        <Badge variant="info">{tool.namespace}</Badge>
        <Badge variant="muted">~{tool.totalTokens} ctx tokens</Badge>
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Server namespaces</p>
          <p class="text-slate-700 dark:text-slate-300">{tool.serverNamespaces.join(', ')}</p>
        </div>
        <div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">Risk</p>
          <p class="text-slate-700 dark:text-slate-300">{tool.riskLevel}</p>
        </div>
      </div>

      <div class="grid gap-4 xl:grid-cols-2">
        <label class="space-y-1 block">
          <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Original description</span>
          <textarea
            readonly
            rows="4"
            value={tool.originalDescription ?? ''}
            class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-sm"
          ></textarea>
        </label>
        <label class="space-y-1 block">
          <span class="text-xs font-medium text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
            Effective description
            <InfoTooltip text="Leave this equal to the original value if you only want to customize the input schema." />
          </span>
          <textarea
            rows="4"
            value={descriptionText}
            oninput={(event) => onDescriptionInput(event.currentTarget.value)}
            class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
          ></textarea>
        </label>
      </div>

      <div class="grid gap-4 xl:grid-cols-2">
        <label class="space-y-1 block">
          <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Original schema</span>
          {#key `${tool.serverId}/${tool.name}`}
            <JsonSchemaEditor
              readOnly={true}
              value={JSON.stringify(tool.originalInputSchema, null, 2)}
            />
          {/key}
        </label>
        <label class="space-y-1 block">
          <span class="text-xs font-medium text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
            Effective schema
            <InfoTooltip text="The effective schema is what will be published to MCP clients after the override is saved." />
          </span>
          {#key `${tool.serverId}/${tool.name}`}
            <JsonSchemaEditor value={editorText} oninput={onEditorInput} />
          {/key}
        </label>
      </div>

      {#if parseError}
        <div class="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-3 text-sm text-red-700 dark:text-red-300">
          {parseError}
        </div>
      {/if}
    </div>

    <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-3">
      <button
        onclick={() => onrevert?.()}
        disabled={saving || !tool.customized}
        class="px-4 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
      >
        Revert to original
      </button>
      <button
        onclick={() => onsave?.()}
        disabled={saving || saveDisabled}
        class="px-4 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : 'Save override'}
      </button>
    </div>
  </aside>
{/if}

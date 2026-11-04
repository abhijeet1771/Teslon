import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useToastStore = defineStore('toast', () => {
  const messages = ref<{ id: number; text: string; kind: 'info' | 'error' }[]>([]);
  let next = 1;

  function show(text: string, kind: 'info' | 'error' = 'info') {
    const id = next++;
    messages.value.push({ id, text, kind });
    setTimeout(() => dismiss(id), 4000);
  }

  function dismiss(id: number) {
    messages.value = messages.value.filter((m) => m.id !== id);
  }

  return { messages, show, dismiss };
});

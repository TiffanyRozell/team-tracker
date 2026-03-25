<template>
  <div>
    <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">Chart Type</h3>
    <div class="inline-flex rounded-md shadow-sm">
      <button
        v-for="(option, i) in options"
        :key="option.value"
        @click="$emit('update:modelValue', option.value)"
        class="px-3 py-1.5 text-sm font-medium border"
        :class="[
          modelValue === option.value
            ? 'bg-primary-600 text-white border-primary-600'
            : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50',
          i === 0 ? 'rounded-l-md' : '',
          i === options.length - 1 ? 'rounded-r-md' : '',
          i > 0 ? 'border-l-0' : ''
        ]"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<script setup>
const options = [
  { value: 'bar', label: 'Bar' },
  { value: 'horizontalBar', label: 'Horizontal' },
  { value: 'doughnut', label: 'Doughnut' }
]

defineProps({
  modelValue: { type: String, required: true }
})
defineEmits(['update:modelValue'])
</script>

import { computed, createApp, h, ref } from 'vue'

const Counter = {
  name: 'Counter',
  props: { label: String },
  setup() {
    const count = ref(0)
    const double = computed(() => count.value * 2)
    return { count, double }
  },
  render() {
    return h('button', { id: 'counter', onClick: () => this.count++ }, `${this.label}: ${this.count} ${this.double}`)
  },
}

createApp({ render: () => h('main', [h('h1', 'Vue'), h(Counter, { label: '클릭' })]) }).mount('#root')

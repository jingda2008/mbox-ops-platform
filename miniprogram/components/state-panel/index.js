Component({
  properties: {
    type: { type: String, value: 'empty' },
    title: { type: String, value: '' },
    message: { type: String, value: '' },
    actionText: { type: String, value: '' },
  },
  methods: {
    handleAction() {
      this.triggerEvent('action')
    },
  },
})

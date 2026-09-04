Component({
  props: {
    type: 'empty',
    title: '',
    message: '',
    actionText: '',
    onAction: null,
  },
  methods: {
    handleAction() {
      if (typeof this.props.onAction === 'function') this.props.onAction()
    },
  },
})

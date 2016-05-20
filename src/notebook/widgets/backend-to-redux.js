import Rx from 'rxjs/Rx';
import { deleteWidget, displayWidget } from '../actions';

export class BackendToRedux {
  constructor(store, dispatch, createModelCb, setStateCb) {
    this.initCommSubscriptions(store);
    this.initStateListeners(dispatch, createModelCb, setStateCb);
  }

  initCommSubscriptions(store) {
    const commMsgs = Rx.Observable.from(store)
      .pluck('app')
      .pluck('channels')
      .distinctUntilChanged()
      .switchMap(channels => {
        if (!(channels && channels.iopub)) {
          return Rx.Observable.empty();
        }
        return channels.iopub
          .filter(msg =>
            msg && msg.header && msg.header.msg_type &&
            msg.header.msg_type.slice(0, 5) === 'comm_'
          );
      });

    const msgs = commMsgs
      .filter(msg => msg.header.msg_type === 'comm_msg')
      .pluck('content');

    // Keep a separate queue for display msgs to avoid asynchronous problems
    // because it takes a while to initiate the widget model.  Cache display
    // calls so they are available when the widgets are constructed.
    this.displayMsgs = commMsgs
      .filter(msg => msg.header.msg_type === 'comm_msg')
      .filter(msg => msg.content.data.method === 'display')
      .map(msg => ({
        parentMsgId: msg.parent_header.msg_id,
        id: msg.content.comm_id,
      }))
      .publishReplay(1000) // Remember a max of 1k msgs
      .refCount();
    // TODO: Dispose me on app cleanup
    this.displayMsgs.subscribe(() => {});

    // new comm observable
    this.comms = {};
    this.dummySubscriptions = {};
    this.newComms = commMsgs
      .filter(msg => msg.header.msg_type === 'comm_open')
      .pluck('content')
      .filter(msg => msg.target_name === 'jupyter.widget') // TODO: name from jupyter-js-widgets
      .map(msg => {
        const id = msg.comm_id;
        const data = msg.data;
        this.comms[id] = msgs
          .filter(subMsg => subMsg.comm_id === id)
          .pluck('data')
          .publishReplay(1000) // Remember a max of 1k msgs
          .refCount();
        this.dummySubscriptions = this.comms[id].subscribe(() => {});
        return { id, data };
      });

    // listen for comm closing msgs
    this.deleteComms = commMsgs
      .filter(msg => msg.header.msg_type === 'comm_close')
      .pluck('content')
      .map(id => {
        delete this.comms[id];
        this.dummySubscriptions[id].unsubscribe();
        delete this.dummySubscriptions[id];
        return id;
      });
  }

  initStateListeners(dispatch, createModelCb, setStateCb) {
    // Use a model instance to set state on widget creation because the
    // widget instantiation logic is complex and we don't want to have to
    // duplicate it.  This is the only point in the lifespan where the widget
    // model is the source of truth.  After it is created, the application
    // state that lives in the state store is the source of truth.  This allows
    // external inputs, like real time collaboration, to work.
    this.newComms
      .switchMap(info => Rx.Observable.fromPromise(createModelCb(info.id, info.data)))
      .subscribe(model => {
        setStateCb(model);

        // State updates are applied to the store, not the widget directly.
        // It's not the responsibility of this code to update the widget model.
        const subscription = this.comms[model.id]
          .filter(content => content.method === 'update')
          .subscribe(content => {
            // TODO: Handle binary `buffers`
            dispatch(setStateCb(model, content.state));
          });

        // Listen for display messages
        const displaySubscription = this.displayMsgs
          .filter(info => info.id === model.id)
          .subscribe(info => dispatch(displayWidget(info.id, info.parentMsgId)));

        // TODO: Handle custom msgs

        // Handle cleanup time
        const deleteSubscription = this.deleteComms
          .filter(id => id === model.id)
          .subscribe(() => {
            subscription.unsubscribe();
            displaySubscription.unsubscribe();
            deleteSubscription.unsubscribe();
            deleteWidget(model.id);
          });
      });
  }
}

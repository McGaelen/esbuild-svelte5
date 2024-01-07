<script>
  import {counter} from "./runes";

  let {myprop} = $props()

  let doubled = $derived(counter.count * 2)

  $effect(() => {
    console.log('i print whenever doubled changes: ', doubled)
  })
</script>

<h1>{myprop}</h1>
<p>Counter: <code>{counter.count}</code></p>
<p>Doubled: <code>{doubled}</code></p>
<button on:click={() => counter.increment()}>Increment</button>

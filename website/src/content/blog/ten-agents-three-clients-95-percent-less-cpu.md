---
title: Ten agents, three clients, 95% less CPU
description: Herdr's sidebar stopped animating, hidden panes stopped drawing, and mouse movement stopped counting as a change. The saving compounds with panes and clients, so the busiest sessions gained the most.
date: 2026-08-03
ogImage: /assets/og-blog-frames-v1.png
draft: false
---

Herdr did not get faster.

That distinction is worth keeping, because the honest version is more interesting. No renderer in Herdr became ten times quicker. Herdr stopped asking the renderer to draw things that nobody was going to look at. In the workloads where that work dominated, total CPU across the server and every attached client fell by 89 to 95 percent.

The saving also compounds, which is the part worth knowing. One agent with one client attached improved 91 percent. Ten agents with background output and three clients attached improved 95, because a frame that is never produced is also never serialized, never transmitted, and never applied by any of them. The busier the session, the more there is to not do.

Three changes got us there, and none of them were found in a profiler. The first started as a complaint, and the rule that came out of it was that motion should mean something changed.

## The spinner was a complaint before it was a cost

Herdr's job is to tell you which agent needs you. You run five, ten, twenty of them, and the sidebar is how you know where to look.

So every working agent got a spinner. It seemed obvious at the time: motion means alive, and an agent that is thinking should look like it is thinking.

Run twenty agents and you find out what that actually builds. Twenty things moving at once, all saying the same thing, none of them saying it is the one that needs you. The workspace list already carried state as coloured dots, and the sidebar was the noisy half of the same information. People told us. We agreed.

The first fix was a performance fix. Instead of rebuilding pane contents for a spinner tick, the server reused the client's retained frame, redrew only the status rectangle, patched it, and sent the smaller result. It worked. It made an animation that should not exist about as cheap as an animation can be.

It was still twenty things moving. So we removed them.

<figure class="pf">
  <div class="pf-2">
    <div class="pf-panel">
      <div class="pf-label"><span>0.7.5</span><b>3 spinners, 8fps</b></div>
      <div class="pf-row working"><span class="pf-mark pf-spin"><i>⠋</i><i>⠙</i><i>⠹</i><i>⠸</i></span><div><strong>herdr</strong><small>working</small></div></div>
      <div class="pf-row working"><span class="pf-mark pf-spin"><i>⠋</i><i>⠙</i><i>⠹</i><i>⠸</i></span><div><strong>web-dashboard</strong><small>working</small></div></div>
      <div class="pf-row blocked"><span class="pf-mark">◉</span><div><strong>llm-proxy</strong><small>blocked, needs you</small></div></div>
      <div class="pf-row working"><span class="pf-mark pf-spin"><i>⠋</i><i>⠙</i><i>⠹</i><i>⠸</i></span><div><strong>data-pipeline</strong><small>working</small></div></div>
      <div class="pf-row done"><span class="pf-mark">●</span><div><strong>docs</strong><small>done</small></div></div>
    </div>
    <div class="pf-panel">
      <div class="pf-label"><span>0.8.0</span><b>nothing moves</b></div>
      <div class="pf-row working"><span class="pf-mark">●</span><div><strong>herdr</strong><small>working</small></div></div>
      <div class="pf-row working"><span class="pf-mark">●</span><div><strong>web-dashboard</strong><small>working</small></div></div>
      <div class="pf-row blocked"><span class="pf-mark">◉</span><div><strong>llm-proxy</strong><small>blocked, needs you</small></div></div>
      <div class="pf-row working"><span class="pf-mark">●</span><div><strong>data-pipeline</strong><small>working</small></div></div>
      <div class="pf-row done"><span class="pf-mark">●</span><div><strong>docs</strong><small>done</small></div></div>
    </div>
  </div>
  <figcaption class="pf-cap">Both panels carry the same information. Only one of them lets you find the blocked agent without reading. The left panel is animating in your browser right now, which is the entire argument.</figcaption>
</figure>

Working state is now a static coloured mark. Entering the state still renders immediately, so a change catches your eye the moment it happens. Staying in it costs nothing, and looks like nothing.

The performance consequence was larger than the design one. Animating that sidebar meant waking on a timer, rendering the status surface, comparing the frame, preparing it, serializing it, sending it to every attached client, and having each client receive and apply it. Roughly eight times a second, for as long as any agent was working, whether or not one other thing on screen had changed.

Removing the spinner removed all of it: the timer, the animation deadlines, the scans asking whether any workspace contained a working pane, the animation-only render causes, the frame patching. Master produces zero scheduled animation frames. One agent working with nothing else on screen went from 1.467 percent CPU to 0.133 on Linux, and from 3.280 to 0.265 on macOS.

We removed spinners because they were noise, not because they were inefficient. 

## The same rule, applied to output you cannot see

Once motion means a change, the question becomes which things are actually changes.

When a pane produced output, the PTY reader set a shared flag meaning something happened. It coalesced wakeups efficiently and threw away the one fact that mattered, which was which pane. So when the server picked that flag up it could not tell whether the pane was even on screen. A background agent writing to a tab you were not looking at went into rendering anyway, and with several clients attached, produced frames for all of them.

<figure class="pf">
  <div class="pf-2">
    <div class="pf-panel">
      <div class="pf-label"><span>0.7.5</span><b>a pane writes</b></div>
      <div class="pf-flow">
        <div class="pf-step"><b>dirty flag set</b><s>something changed, we do not know what</s></div>
        <div class="pf-arrow">│</div>
        <div class="pf-step"><b>render</b><s>no way to rule it out</s></div>
        <div class="pf-arrow">│</div>
        <div class="pf-step"><b>serialize, transmit</b><s>once per attached client</s></div>
        <div class="pf-arrow">│</div>
        <div class="pf-step pf-cost"><b>3 clients apply a frame</b><s>for a tab none of them are showing</s></div>
      </div>
    </div>
    <div class="pf-panel">
      <div class="pf-label"><span>0.8.0</span><b>a pane writes</b></div>
      <div class="pf-flow">
        <div class="pf-step"><b>request_pty(pane 7)</b><s>the source is kept</s></div>
        <div class="pf-arrow">│</div>
        <div class="pf-step"><b>can any client see pane 7?</b><s>tabs, zoom, popups, direct attaches</s></div>
        <div class="pf-fork">
          <div class="pf-step pf-stop"><em>├─ no</em><b>stop here</b><s>bytes already parsed, nothing drawn</s></div>
          <div class="pf-step"><em>└─ yes</em><b>render as before</b><s>visible output is still visible output</s></div>
        </div>
      </div>
    </div>
  </div>
  <figcaption class="pf-cap">Render requests now carry their source. Writes from one pane coalesce into a single entry, while simultaneous writes from different panes each keep their identity.</figcaption>
</figure>

Skipping loses nothing. The bytes have already been parsed, so terminal state, scrollback, cursor, OSC metadata and agent detection all stay current. Switching to that tab renders from that state normally. Where the mapping is unknown, the pane is treated as visible rather than suppressed, because a wrong skip costs you a stale screen and a wrong render costs some CPU. Those are not the same kind of mistake.

## And to input that changes nothing

Every mouse event reported that the view had changed. Pointer movement over a pane is forwarded to the application inside it, but Herdr's own frame is usually identical before and after. At 60 motion events per second, that meant roughly 60 server renders and 60 client frames per second, to draw the same picture sixty times.

Herdr now knows which of its own modes respond to hover, which is the global menu, context menus and the navigator. Outside those, movement alone repaints nothing, while the events themselves still route through to the pane exactly as before.

The benchmark counted both ends. In every measured round, on both builds, 1,680 motion packets were sent and all 1,680 arrived in the pane. Version 0.7.5 emitted around 56 to 60 frames per second doing it. Master emitted none. Linux CPU fell from 9.450 percent to 0.667.

## Why three changes became ninety percent

A render avoided at the server is not one saving. It is the frame preparation, the serialization, the transmission and the frame handling in every attached client, none of which happen.

That is why the numbers grow with clients rather than shrinking. Ten silent working panes with one client improved 78 percent. The same panes with three clients improved 91.

<figure class="pf">
  <div class="pf-panel">
    <div class="pf-label"><span>total CPU, server plus every attached client</span><b>linux</b></div>
    <div class="pf-bars">
      <div class="pf-bar-row">
        <div class="pf-bar-name">one silent working pane</div>
        <div class="pf-bar old"><span>0.7.5</span><i style="width:11.3%"></i><em>1.467%</em></div>
        <div class="pf-bar new"><span>0.8.0</span><i style="width:1%"></i><em>0.133%</em></div>
      </div>
      <div class="pf-bar-row">
        <div class="pf-bar-name">ten silent working panes, three clients</div>
        <div class="pf-bar old"><span>0.7.5</span><i style="width:33.2%"></i><em>4.316%</em></div>
        <div class="pf-bar new"><span>0.8.0</span><i style="width:3.1%"></i><em>0.400%</em></div>
      </div>
      <div class="pf-bar-row">
        <div class="pf-bar-name">ten panes, nine hidden writers, three clients</div>
        <div class="pf-bar old"><span>0.7.5</span><i style="width:100%"></i><em>13.014%</em></div>
        <div class="pf-bar new"><span>0.8.0</span><i style="width:4.7%"></i><em>0.617%</em></div>
      </div>
      <div class="pf-bar-row">
        <div class="pf-bar-name">passive mouse motion at 60Hz</div>
        <div class="pf-bar old"><span>0.7.5</span><i style="width:72.6%"></i><em>9.450%</em></div>
        <div class="pf-bar new"><span>0.8.0</span><i style="width:5.1%"></i><em>0.667%</em></div>
      </div>
      <div class="pf-bar-row">
        <div class="pf-bar-name">forty-nine hidden writers at 60Hz</div>
        <div class="pf-bar old"><span>0.7.5</span><i style="width:44.6%"></i><em>5.800%</em></div>
        <div class="pf-bar new"><span>0.8.0</span><i style="width:34.1%"></i><em>4.433%</em></div>
      </div>
    </div>
  </div>
  <figcaption class="pf-cap">The last row is the one to look at. macOS followed the same shape, from 22.958 percent to 1.673 on the hidden output case and from 14.857 to 13.498 on the last one.</figcaption>
</figure>

On 0.7.5, adding hidden background output to a session cost 8.7 CPU points on Linux and 12.7 on macOS. On master the same activity costs 0.2 and 0.6, which is roughly the price of reading and parsing the bytes and nothing else.

## Where it does not help

Fifty panes, forty-nine of them writing at 60Hz, is about 2,940 terminal updates per second. Every one of them still has to be read from the PTY and parsed into terminal state, because that is what makes the pane correct when you switch to it. Suppressing frames cannot suppress terminal emulation.

That case improved 23.6 percent on Linux and 9.1 on macOS. Visible output at 60Hz, a pane you are actually watching, improved 33.9 percent on Linux and 2.7 on macOS, which is to say it did not regress. Idle sat at the measurement floor on both builds and deserves no percentage claim at all.

None of those are the headline. All of them are the point. The gains are large exactly where the work was unnecessary and small exactly where it was not.

## How this was measured

Official 0.7.5 release binaries against hashed master builds, on separate Linux and macOS machines, giving 54 isolated observations per operating system. Every run used a fresh named session, real attached clients in fixed 86 by 47 terminals, a five second warmup and twenty one second samples. The figures are total CPU for the Herdr server plus every attached client.

Every headline result also has a behavioural counter behind it rather than only a CPU total: scheduled frames per second for the sidebar, hidden source skips for background output, exact packet delivery counts for mouse motion. A CPU number on its own can be explained by a dozen things. A CPU number with a matching mechanism counter is harder to argue with.

One limit worth stating plainly. This compares a shipped release against master, so intervening changes and build environments are part of what is being compared. The profiler evidence matches the mechanisms closely, but not every CPU point can be assigned to one commit.

None of this started in a profiler. It started with people saying the sidebar was too busy, and with bug reports and performance reports from people running far stranger sessions than we test. Keep them coming. Thank you to everyone helping make Herdr better.

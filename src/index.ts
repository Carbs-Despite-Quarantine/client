import io from "socket.io-client";
import $ from "jquery";
import 'jquery-ui/ui/widgets/sortable';

import {User, UserState} from "./struct/users";
import {Message, Room, RoomState} from "./struct/rooms";
import {BlackCard, Card} from "./struct/cards";

/********************
 * Global Variables *
 ********************/

const socket = io("http://localhost:3000");

let userId: number;
let roomId: number | null = null;

let users: Record<number, User> = {};
let room: Room | null = null;

let cards = {};

// Used to hide the "Link Copied" notification after a few seconds
let copyLinkPersitTimer: number | null = null;
let copyLinkFadeTimer: number | null = null;

// Used to track the expansions enabled in the room setup menu
let expansionsSelected: Array<string> = [];

// The ID of the currently selected white card
let selectedCard: number | null = null;

// Set to true while waiting for a server response from selectCard
let submittingCard = false;

// jQuery element cache
const setupSpinner = $("#setup-spinner") as JQuery;
const chatHistory = $("#chat-history") as JQuery;
const chatInput = $("#chat-input") as JQuery;
const curBlackCard = $("#cur-black-card") as JQuery;
const centralAction = $("#central-action") as JQuery;

/********************
 * Helper Functions *
 ********************/

function getURLParam(name: string): string | null {
  let results = new RegExp('[\?&]' + name + '=([^&#]*)').exec(window.location.href);
  return results && results[1] || null;
}

function resetRoomMenu() {
  $("#select-icon").show();
  $("#set-username-submit").attr("value", "Set Username");

  // TODO: is this even legal? (null as unknown as string)
  window.history.pushState(null, null as unknown as string, window.location.href.split("?")[0]);

  roomId = null;
  room = null;
}

function clearResponseCards() {
  curBlackCard.removeClass("responses-shown").removeClass("czar-mode");
  $("#select-winner").hide();
  $("#response-cards").empty();
  $("#response-cards").removeClass("more-than-three");
  selectedCard = null;

  $(".selected-card").removeClass("selected-card");
  centralAction.hide();
}

function startChoosing() {
  for (const roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.idle) setUserState(roomUser.id, UserState.choosing);
  }

  if (room) room.state = RoomState.choosingCards;
}

function scrollMessages() {
  chatHistory.scrollTop(chatHistory.prop("scrollHeight"));
}

function likeMessage(message: Message) {
  if (message.likes.indexOf(userId) != -1) return console.warn("Can't like a message twice!");
  socket.emit("likeMessage", {
    msgId: message.id
  }, (response: any) => {
    if (response.error) return console.warn("Failed to like message #" + message.id + ":", response.error);
    addLikes(message.id, [userId]);
  });
}

// Re-initializes the given likes div with just heart icon
function clearLikesDiv(likesDiv: JQuery, msgId: number) {
  if (!room) return console.warn("Tried to clear likes div when not in a room!");

  likesDiv.html(`
    <div class="msg-heart">
      <i class="far fa-heart"></i>
    </div>
  `);

  let message = room.messages[msgId];

  // Listen for clicks on the heart icon
  likesDiv.children(".msg-heart").first().click(event => {
    // Remove like if already added
    if (message.likes.indexOf(userId) != -1) {
      socket.emit("unlikeMessage", {
        msgId: msgId
      }, (response: any) => {
        if (response.error) return console.warn("Failed to unlike message #" + msgId + ":", response.error);
        removeLike(msgId, userId);
      });
    } else {
      likeMessage(message);
    }
  });
}

function getOrCreateLikesDiv(msgId: number): JQuery | undefined {
  let msgDiv = $("#msg-" + msgId);
  if (msgDiv.length === 0) {
    console.warn("Tried to create like div for invalid msg #", msgId);
    return undefined;
  }

  let contentDiv = msgDiv.first().children(".msg-content");
  if (contentDiv.length === 0) {
    console.warn("Failed to get content div for msg #" + msgId);
    return undefined;
  }

  let likesDiv = contentDiv.children(".msg-likes");
  if (likesDiv.length > 0) {
    return likesDiv.first();
  }
  
  contentDiv.append(`<div class="msg-likes"></div>`);
  clearLikesDiv(contentDiv.children(".msg-likes").first(), msgId);

  return contentDiv.children(".msg-likes").first();
}

function addLikes(msgId: number, userIds: Array<number>, addToMessage=true) {
  if (!room) return console.warn("Tried to add likes to msg #" + msgId + " when not in a room!");
  if (!room.messages.hasOwnProperty(msgId)) {
    console.warn("Tried to add likes to untracked message #", msgId);
    return;
  }

  const likesDiv = getOrCreateLikesDiv(msgId);
  if (!likesDiv) return console.warn("Failed to add likes to message #", msgId);
  let message = room.messages[msgId];

  userIds.forEach(likeId => {
    if (!users.hasOwnProperty(likeId)) {
      return console.warn("Received like from invalid user #" + likeId);
    } else if (message.likes.indexOf(likeId) != -1 && addToMessage) {
      return console.warn("User #" + likeId + " tried to like message #" + msgId + " twice!");
    }
    if (addToMessage) message.likes.push(likeId);
    if (likeId === userId) {
      let heart = likesDiv.children(".msg-heart").first().children("i").first();

      // Replace the empty heart with a full heart
      heart.removeClass("far");
      heart.addClass("fas");
    }
    let user = users[likeId];
    likesDiv.append(`
      <div class="msg-like">
        <i class="fas fa-${user.icon}" title="Liked by ${user.name}"></i>
      </div>
    `);
  });
  scrollMessages();
}

function removeLike(msgId: number, userId: number) {
  if (!room) return console.warn("Tried to remove a like when not in aa room!");
  if (!room.messages.hasOwnProperty(msgId)) {
    return console.warn("Tried to remove a like from untracked message #", msgId);
  }
  const likesDiv = getOrCreateLikesDiv(msgId);
  if (!likesDiv) return console.warn("Failed to remove a like from message #", msgId);

  let message = room.messages[msgId];
  let likeIndex = message.likes.indexOf(userId);
  if (likeIndex > -1) message.likes.splice(likeIndex, 1);

  // Simply delete the likes div if this was the last like
  if (Object.keys(message.likes).length === 0) {
    likesDiv.remove();
    return;
  }
  clearLikesDiv(likesDiv, msgId);
  addLikes(msgId, message.likes, false);
}

function addMessage(message: Message, addToRoom=true) {
  if (!room) return console.warn("Tried to add a message when not in a room!");

  $("#chat-history").append(`
    <div class="icon-container msg-container ${message.isSystemMsg ? "system-msg" : "user-msg"}" id="msg-${message.id}">
      <div class="icon msg-icon">
        <i class="fas fa-${users[message.userId].icon}"></i>
      </div>
      <div class="content msg-content">
        <h2>${users[message.userId].name}</h2>
        <p>${message.content}</p>
      </div>
    </div>
  `);

  // Add existing likes to the message
  if (Object.keys(message.likes).length > 0) {
    addLikes(message.id, message.likes, false);
  }

  scrollMessages();

  if (addToRoom) {
    room.messages[message.id] = message;
  }

  if (!message.isSystemMsg) {
    $("#msg-" + message.id).dblclick(event => likeMessage(message));
  }
}

function populateChat(messages: Record<number, Message>) {
  for (let msgId in messages) {
    addMessage(messages[msgId], false);
  }
}

/*************
 * User List *
 *************/

function getStateString(state: UserState) {
  switch(state) {
    case UserState.winner:
      return "Winner";
    case UserState.czar:
      return "Card Czar";
    case UserState.idle:
      return "Ready";
    case UserState.choosing:
      return "Choosing";
    case UserState.inactive:
      return "Inactive";
  }
}

function addUser(user: User) {
  $("#user-list").append(`
    <div class="icon-container user-display" id="user-${user.id}">
      <div class="icon user-icon">
        <i class="fas fa-${user.icon}"></i>
      </div>
      <div class="content user-info">
        <h2>${user.name}</h2>
        <p id="user-state-${user.id}">${getStateString(user.state)}</p>
      </div>
      <div class="user-score">
        <h2 id="user-score-${user.id}">${user.score}</h2>
      </div>
    </div>
  `);
}

function sortUserList() {
  $("#user-list").empty();

  let activeUsers: Array<User> = [];
  let inactiveUsers: Array<User> = [];

  for (const roomUserId in users) {
    let roomUser = users[roomUserId];

    if (roomUser.state === UserState.inactive) inactiveUsers.push(roomUser);
    else activeUsers.push(roomUser);
  }

  activeUsers.sort((a, b) => b.score - a.score);
  inactiveUsers.sort((a, b) => b.score - a.score);

  activeUsers.forEach(roomUser => {
    if (roomUser.icon && roomUser.name) addUser(roomUser);
  });

  inactiveUsers.forEach(roomUser => {
    if (roomUser.icon && roomUser.name) addUser(roomUser);
  })
}

function setUserState(userId: number, state: UserState) {
  users[userId].state = state;
  $("#user-state-" + userId).text(getStateString(state));
}

function setUserScore(userId: number, score: number) {
  users[userId].score = score;
  $("#user-score-" + userId).text(score);
}

/**********************
 * Expansion Selector *
 **********************/

function addExpansionSelector(id: string, name: string) {
    $("#expansions-list").append(`
    <div class="expansion" id="expansion-${id}">
      <span class="expansion-name">${name}</span>
      </div>
  `);
  
  // Clicking an expansion will toggle it
  $("#expansion-" + id).click(event => {
    let target = $("#expansion-" + id);
    if (target.hasClass("selected")) {
      target.removeClass("selected");
      let expansionIndex = expansionsSelected.indexOf(id);
      if (expansionIndex > -1) expansionsSelected.splice(expansionIndex, 1);
    } else {
      target.addClass("selected");
      expansionsSelected.push(id);
    }
  });
}
/*****************
 * Icon Selector *
 *****************/

// Every unused icon
let availableIcons: Array<string> = [];

// The icons displayed in the icon selection panel
let iconChoices: Array<string> = [];

// The currently selected icon name
let selectedIcon: string | null = null;

function setIcon() {
  if (!selectedIcon || !userId) return;

 $("#select-icon").hide();
 setupSpinner.show();
  
  socket.emit("setIcon", {
    icon: selectedIcon
  }, (response: any) => {
    setupSpinner.hide();
    if (response.error) {
      console.error("Failed to set icon:", response.error);
      $("#select-icon").show();
      return;
    }
    $("#set-username").show();
    users[userId].icon = selectedIcon as string;
 });
}

function addIcon(name: string) {
  $("#select-icon").children("#icons").append(`
    <div class="icon ${name == selectedIcon ? "selected" : ""}" id="icon-${name}">
      <i class="fas fa-${name}"></i>
    </div>
  `);
  // Add a click listener to select the icon
  const element = $("#icon-" + name);
  if (element.length == 0) return console.warn("Failed to get icon " + name);

  element.on("click",event => {
    let idStr = element.attr("id");
    if (!idStr) return console.warn("Clicked on invalid icon button");

    let idMatch = idStr.match(/icon-(.*)/);
    if (!idMatch) return console.warn("Failed to get icon name from string '" + idStr + "'");
    let curName = idMatch[1];

    $(".icon").removeClass("selected");
    element.addClass("selected");
    selectedIcon = curName;

    $("#set-icon").prop("disabled", false);
  });

  element.dblclick(event => {
    setIcon();
  });
}

function populateIconSelector(icons: Array<string>) {
  $("#select-icon").children("#icons").empty();
  availableIcons = icons;
  iconChoices = [];

  let maxIcons = 14;
  if (maxIcons > icons.length) maxIcons = icons.length;

  while (iconChoices.length < maxIcons) {
    let icon = icons[Math.floor(Math.random() * icons.length)];
    if (iconChoices.indexOf(icon) != -1) continue;

    iconChoices.push(icon);
    addIcon(icon);
  }

  if (selectedIcon && iconChoices.indexOf(selectedIcon) == -1) selectedIcon = null;
}

$("#set-icon").click(event => {
  setIcon();
});

socket.on("iconTaken", (event: any) => {
  let iconIndex = availableIcons.indexOf(event.icon);
  if (iconIndex > -1) availableIcons.splice(iconIndex, 1);

  iconIndex = iconChoices.indexOf(event.icon);
  if (iconIndex > -1) iconChoices.splice(iconIndex, 1);

  if (selectedIcon == event.icon) {
    selectedIcon = null;
    $("#set-icon").prop("disabled", true);
  }

  let iconElement = $("#icon-" + event.icon);
  if (iconElement.length > 0) {
    // If there are no excess available items, simply hide the icon
    if (iconChoices.length >= availableIcons.length) {
      iconElement.hide();
      return;
    }

    // Find a new icon to replace it
    let newIcon;
    while (!newIcon || iconChoices.indexOf(newIcon) != -1) {
      newIcon = availableIcons[Math.floor(Math.random() * availableIcons.length)];
    }

    iconElement.attr("id", "icon-" + newIcon);
    iconElement.removeClass("selected");

    // Replace the font awesome icon class
    let faElement = iconElement.children("i");
    faElement.removeClass("fa-" + event.icon);
    faElement.addClass("fa-" + newIcon);
  }
});

/*******************
 * Socket Handling *
 *******************/

socket.on("init", (data: any) => {
  if (data.error) return console.error("Failed to initialize socket:", data.error);
  console.debug("Obtained userId " + data.userId);
  userId = data.userId;
  let roomIdStr = getURLParam("room");
  let roomToken: string | null= null;

  if (roomIdStr) {
    roomId = parseInt(roomIdStr);
    roomToken = getURLParam("token");
  }

  users[userId] = new User(userId, UserState.idle,undefined, undefined,0);

  if (roomId) {
    console.debug("Trying to join room #" + roomId + " with token #" + roomToken);
    $("#set-username-submit").attr("value", "Join Room");

    socket.emit("joinRoom", {
      roomId: roomId,
      token: roomToken
    }, (response: any) => {
      if (response.error) {
        console.warn("Failed to join room #" + roomId + ":", response.error);
        setupSpinner.hide();
        resetRoomMenu();
        populateIconSelector(data.icons);
        return;
      }

      populateIconSelector(response.iconChoices);
      console.debug("Joined room #" + roomId);

      users = response.users;
      room = response.room;
      if (!room) return console.warn("Recieved invalid room");

      room.link = window.location.href;

      populateChat(room.messages);
      sortUserList();

      if (room.curPrompt) setBlackCard(room.curPrompt);

      setupSpinner.hide();
    });
  } else {
    populateIconSelector(data.icons);
    setupSpinner.hide();
  }
});

socket.on("userJoined", (data: any) => {
  if (!room) return console.warn("Received user join event when not in a room");
  users[data.user.id] = data.user;
  if (data.message) addMessage(data.message);
  sortUserList();
});

socket.on("userLeft", (data: any) => {
  if (!room) return console.error("Recieved user left event when not in a room");
  if (!users.hasOwnProperty(data.userId)) {
    return console.error("Recieved leave message for unknown user #" + data.userId);
  }
  if (data.message) addMessage(data.message);

  users[data.userId].state = UserState.inactive;
  sortUserList();
});

socket.on("roomSettings", (data: any) => {
  if (!room) return console.warn("Received room settings when not in a room");
  console.debug("Room has been set to " + data.edition + " edition!");

  room.edition = data.edition;
  room.rotateCzar = data.rotateCzar;
  startChoosing();

  if (data.hand) addCardsToDeck(data.hand);
  setBlackCard(data.blackCard);
});

window.addEventListener("beforeunload", (event) => {
  socket.emit("userLeft");
});

/**************
 * Room Setup *
 **************/

$("#username-input").keyup(event => {
  let userName = ($("#username-input").val() as string).replace(/^\s+|\s+$/g, "");
  $("#set-username-submit").prop("disabled", userName.length === 0);
});

$("#set-username").submit(event => {
  event.preventDefault();

  let user = users[userId];
  let userName = $("#username-input").val();

  $("#set-username").hide();
  setupSpinner.show();

  // If the user is already in a room, enter it
  if (room) {
    console.debug("Entering room #" + room.id + "...");
    socket.emit("enterRoom", {
      userName: userName
    }, (response: any) => {
      // TODO: this is a bit dumb
      room = room as Room;

      setupSpinner.hide();

      if (response.error) {
        console.error("Failed to join room #" + room.id + ":", response.error);
        resetRoomMenu();
        return;
      }

      console.debug("Entered room #" + room.id);
      addCardsToDeck(response.hand);

      $("#overlay-container").hide();

      user.name = userName as string;
      user.state = response.state;
      if (response.message) addMessage(response.message);

      sortUserList();
    });
  } else {
    console.debug("Creating room...");
    socket.emit("createRoom", {
      userName: userName
    }, (response: any) => {
      if (response.error) {
        setupSpinner.hide();
        $("#set-username").show();
        return console.error("Failed to create room:", response.error);
      }
      room = response.room as Room;
      roomId = room.id;
      user.name = userName as string;
      user.state = UserState.czar;

      // Clear and cache the edition menu in order to re-populate it
      let editionMenu = $("#select-edition");
      editionMenu.empty();

      // Populate the edition selection menu
      for (let edition in response.editions) {
        editionMenu.append(`<option value="${edition}">${response.editions[edition]}</option>`);
      }

      for (let pack in response.packs) {
        addExpansionSelector(pack, response.packs[pack]);
      }

      console.debug("Created room #" + room.id);

      $("#room-setup-window").show();
      $("#user-setup-window").hide();

      room.link = window.location.href.split("?")[0] + "?room=" + room.id + "&token=" + room.token;

      // TODO: bit dumb
      window.history.pushState(null, null as unknown as string, room.link);

      populateChat(room.messages);
      sortUserList();

      setupSpinner.hide();
    });
  }
});

$("#start-game").click(() => {
  if (!room) return console.error("Attempted to start game without a room ID");

  console.debug("Starting game...");

  $("#room-setup-window").hide();
  $("#user-setup-window").show();
  setupSpinner.show();

  let title = $("#settings-title");
  title.children("h1").text("Configuring Room...");
  title.children("p").text("Please wait a second.");
  title.show();

  let edition = $("#select-edition").val();
  let rotateCzar = $("#select-czar").val() == "rotate";

  socket.emit("roomSettings", {
    edition: edition,
    rotateCzar: rotateCzar,
    packs: expansionsSelected
  }, (response: any) => {
    setupSpinner.hide();

    if (response.error) {
      $("#room-setup-window").show()
      $("#user-setup-window").hide();
      return console.warn("Failed to setup room:", response.error);
    }

    startChoosing();
    $("#overlay-container").hide();
    addCardsToDeck(response.hand);
    setBlackCard(response.blackCard);
  });
});

$("#room-link").click(() => {
  if (!room || !room.link) return console.warn("Not in a room!");

  // Actually copy the link
  $("body").append(`<textarea id="fake-for-copy" readonly>${room.link}</textarea>`);
  let fake = $("#fake-for-copy")[0];
  // TODO: error ?!
  // @ts-ignore
  fake.select();
  document.execCommand("copy");
  fake.remove();

  // "Link Copied!" notification logic
  $("#link-copy-notification").show().css("opacity", 100).removeClass("visible");
  if (copyLinkFadeTimer) clearTimeout(copyLinkFadeTimer);
  if (copyLinkPersitTimer) clearTimeout(copyLinkPersitTimer);
  copyLinkPersitTimer = setTimeout(() => {
    $("#link-copy-notification").css("opacity", 0).addClass("visible");
    if (copyLinkFadeTimer) clearTimeout(copyLinkFadeTimer);
    copyLinkFadeTimer = setTimeout(() => {
      if ($("#link-copy-notification").hasClass("visible")) {
        $("#link-copy-notification").removeClass("visible").hide();
      }
    }, 2000);
  }, 1000);
});

/***************
 * Chat System *
 ***************/

$("#chat-input").keyup(event => {
  event.stopPropagation();

  let content = chatInput.val();
  if (typeof content !== "string") return;

  let contentStripped = content.replace(/^\s+|\s+$/g, "");

  // 13 is the keycode for enter
  if (contentStripped.length > 0 && event.which === 13) {
    socket.emit("chatMessage", {
      content: contentStripped
    }, (response: any) => {
      $("#chat-input").val("");
      if (response.error) return console.warn("Failed to send chat message:", response.error);
      if (response.message) addMessage(response.message);
    });

  }
});

$(window).resize(event => {
  scrollMessages();
});

socket.on("chatMessage", (data: any) => {
  if (data.message) addMessage(data.message);
});

socket.on("likeMessage", (data: any) => {
  if (data.msgId && data.userId) addLikes(data.msgId, [data.userId]);
});

socket.on("unlikeMessage", (data: any) => {
  if (data.msgId && data.userId) removeLike(data.msgId, data.userId);
});

/********
 * Game *
 ********/

// TODO: display aand allow czar to pick
socket.on("cardChoices", (data: any) => {
  console.debug("Card choices:", data);
});

socket.on("userState", (data: any) => {
  setUserState(data.userId, data.state);
});

socket.on("answersReady", () => {
  if (!room) return console.warn("Received answersReady when not in a room");
  else if (users[userId].state !== UserState.czar) return console.warn("Received answersReady state despite not being czar");
  else if (room.state !== RoomState.choosingCards) return console.warn("Received answersReady when room was in state #" + room.state);
  centralAction.show().text("Read Answers");
});

socket.on("answersNotReady", () => {
  if (!room) return console.warn("Received answersNotReady when not in a room");
  else if (users[userId].state !== UserState.czar) return console.warn("Received answersNotReady state despite not being czar");
  else if (room.state !== RoomState.choosingCards) return console.warn("Received answersNotReady when room was in state #" + room.state);
  centralAction.hide();
});

socket.on("startReadingAnswers", (data: any) => {
  if (!room) return console.warn("Tried to start reading answers when not in a room");

  room.state = RoomState.readingCards;
  let isCzar = users[userId].state === UserState.czar;

  for (let roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.choosing) setUserState(roomUser.id, UserState.idle);
  }

  curBlackCard.addClass("responses-shown");

  for (let i = 0; i < data.count; i++) {
    addResponseCard(i, isCzar);
  }

  if (data.count > 3) {
    $("#response-cards").addClass("more-than-three");
  }
});

socket.on("revealResponse", (data: any) => {
  let cardElement = $("#response-card-" + data.position);
  cardElement.removeClass("back").addClass("front");
  cardElement.children(".card-text").text(data.card.text);
  cardElement.attr("id", "response-revealed-" + data.card.id);

  if (users[userId].state === UserState.czar) {
    $("#response-revealed-" + data.card.id).off("click").on("click", event => {
      if (selectedCard) {
        $("#response-revealed-" + selectedCard).removeClass("selected-card");
      }
      $("#response-revealed-" + data.card.id).addClass("selected-card");
      selectedCard = data.card.id;

      $("#select-winner").show();
      curBlackCard.addClass("czar-mode");
      console.debug("Selecting response #" + data.card.id);
      socket.emit("selectResponse", {cardId: data.card.id}, (response: any) => {
        if (response.error) return console.warn("Failed to select response:", response.error);
      });
    });
  }
});

socket.on("selectResponse", (data: any) => {
  $(".selected-card").removeClass("selected-card");
  if (data.cardId) $("#response-revealed-" + data.cardId).addClass("selected-card");
});

socket.on("selectWinner", (data: any) => {
  if (!room) return console.warn("Tried to select winner when not in a room");

  users[data.userId].score += 1;

  for (const roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.inactive) continue;
    roomUser.state = roomUser.id === data.userId ? UserState.winner : UserState.idle;
  }

  sortUserList();

  room.state = RoomState.viewingWinner;

  clearResponseCards();

  curBlackCard.addClass("winner-shown");
  appendCard(data.card, curBlackCard);

  // Show the 'next round' button if we are the winner
  if (data.userId === userId) {
    centralAction.show().text("Next Round");
  }
});

socket.on("nextRound", (data: any) => {
  if (!room) return console.warn("Tried to start next round when not in a room");
  console.debug("Starting next round with user #" + data.czar + " as the card czar", room, data);

  room.state = RoomState.choosingCards;
  for (const roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.inactive) continue;
    users[roomUser.id].state = roomUser.id === data.czar ? UserState.czar : UserState.choosing;
  }

  sortUserList();

  clearResponseCards();
  curBlackCard.removeClass("winner-shown");

  if (data.card) setBlackCard(data.card);
});

/********************
 * Card Interaction *
 ********************/


function appendCardBack(target: JQuery, id: string, isWhite=true) {
  target.append(`
    <div class="card ${isWhite ? "white" : "black"} back" id="${id}">
      <div class="card-text">Cards Against Quarantine</div>
    </div>
  `);
}

function addResponseCard(id: number, isCzar: boolean) {
  appendCardBack($("#response-cards"), "response-card-" + id);

  // Only the czar can reveal answers
  if (isCzar) {
    $("#response-card-" + id).on("click", event => {
      socket.emit("revealResponse", {position: id}, (response: any) => {
        if (response.error) return console.warn("Failed to reveal response #" + id + ":", response.error);
      });
    });
  }
}

function appendCard(card: Card, target: JQuery, isWhite=true) {
  let color = isWhite ? "white" : "black";
  let id = color + "-card-" + card.id;
  let html = `<div class="card ${color} front" id="${id}">`;
  if (card instanceof BlackCard) {
    if (card.draw === 2) html += `<div class="special draw"></div>`;

    let pick = card.pick;
    if (pick > 1) {
      html += `<div class="special pick`;
      if (pick > 2) html += " pick-three";
      html += `"></div>`;
    }
  }
  target.append(html + `<div class="card-text">${card.text}</div></div>`);
}

// TODO: animate?
function addCardToDeck(card: Card) {
  appendCard(card, $("#hand"));
  let cardElement = $("#white-card-" + card.id);
  cardElement.on("click", () => {
    if (users[userId].state !== UserState.choosing || submittingCard) return;
    if (selectedCard) {
      $("#white-card-" + selectedCard).removeClass("selected-card");
    }
    cardElement.addClass("selected-card");
    selectedCard = card.id;
    centralAction.show().text("Submit Card");
  });
}

function addCardsToDeck(newCards: Record<number, Card>) {
  $("#recycle-hand").show();
  for (let cardId in newCards) {
    addCardToDeck(newCards[cardId]);
  }
}

function setBlackCard(blackCard: BlackCard) {
  curBlackCard.empty();
  appendCard(blackCard, curBlackCard, false);
}

$("#hand").sortable({
  tolerance: "pointer"
});

$("#game-wrapper").on("click",event => {
  if (!room) return;

  if (!submittingCard && selectedCard && ($(event.target).is("#game-wrapper") || $(event.target).is("#hand") || $(event.target).is("#response-cards"))) {
    $("#white-card-" + selectedCard).removeClass("selected-card");
    $("#response-revealed-" + selectedCard).removeClass("selected-card");
    selectedCard = null;

    if (room.state === RoomState.readingCards) {
      $("#select-winner").hide();
      curBlackCard.removeClass("czar-mode");
      socket.emit("selectResponse", {cardId: null}, (response: any) => {
        if (response.error) return console.warn("Failed to deselect card:", response.error);
      });
    } else {
      centralAction.hide();
    }
  }
})

function submitCard() {
  centralAction.hide();
  if (selectedCard && !submittingCard) {
    submittingCard = true;
    let cardId = selectedCard;
    socket.emit("submitCard", {
      cardId: cardId
    }, (response: any) => {
      submittingCard = false;
      if (response.error) {
        console.warn("Failed to submit card #" + selectedCard + ":", response.error);
        return centralAction.show().text("Submit Card");
      }
      selectedCard = null;
      $("#white-card-" + cardId).remove();

      if (response.newCard) addCardToDeck(response.newCard);
      setUserState(userId, UserState.idle);
    });
  }
}

centralAction.on("click", () => {
  if (!room) return console.warn("Central action button clicked when not in a room");
  let curState = users[userId].state;

  // Go to the next round if 'Next Round' button is shown
  if (room.state === RoomState.viewingWinner) {
    if (curState !== UserState.winner) {
      return console.warn("Non-winner tried to start next round!");
    }
    socket.emit("nextRound", {}, (response: any) => {
      if (response.error) return console.warn("Failed to start the next round:", response.error);
      centralAction.hide();
    });
    return;
  }


  if (curState === UserState.czar) {
    socket.emit("startReadingAnswers", {}, (response: any) => {
      if (response.error) return console.warn("Failed to start reading answers:", response.error);
      centralAction.hide();
    });
  } else if (curState === UserState.choosing) {
    submitCard();
  }
});

$("#select-winner").on("click", () => {
  if (users[userId].state === UserState.czar && selectedCard) {
    socket.emit("selectWinner", {cardId: selectedCard}, (response: any) => {
      if (response.error) return console.warn("Failed to select winning card:", response.error);
    })
  }
});

$("#recycle-hand").on("click", () => {
  if (!room || room.state === RoomState.new) return console.warn("Can't recycle hand before room is setup!");
  socket.emit("recycleHand", (response: any) => {
    if (response.error) return console.warn("Failed to recycle hand:", response.error);
    if (response.cards) {
      $("#hand").empty();
      addCardsToDeck(response.cards);
    }
    if (response.message) addMessage(response.message);
  });
});
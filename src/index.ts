import io from "socket.io-client";
import $ from "jquery";
import 'jquery-ui/ui/widgets/sortable';

import * as helpers from "./client-helpers";

import {User, UserState} from "./struct/users";
import {Message, Room, RoomState} from "./struct/rooms";
import {BlackCard, Card} from "./struct/cards";

/********************
 * Global Variables *
 ********************/

const socket = io("http://localhost:3000", {transports: ["websocket"]});

let userId: number;
let userToken: string | undefined;

let roomId: number | null = null;

let users: Record<number, User> = {};
let room: Room | null = null;

// Used for the admin settings panel
let packs: Record<string, { id: string, name: string, enabled: boolean }> = {};

// Used to hide the "Link Copied" notification after a few seconds
let copyLinkPersitTimer: number | null = null;
let copyLinkFadeTimer: number | null = null;

// Used to track the expansions enabled in the room setup menu
let expansionsSelected: Array<string> = [];

// Map between selection number (1-3) and card ID
let selectedCards: { [pos: number]: number } = {};

// The selected response group id
let selectedGroup: number | null = null;

// Set to true while waiting for a server response from selectCard
let submittingCards = false;

// Set to true while waiting for a response from recycleHand
let recyclingCards = false;

// Set to true while the admin settings window is visible
let adminSettingsOpen = false;

// jQuery element cache
const setupSpinner = $("#setup-spinner") as JQuery;
const overlayContainer = $("#overlay-container") as JQuery;
const joinOrCreateDialog = $("#join-or-create") as JQuery;
const iconSelector = $("#select-icon") as JQuery;
const iconBackBtn = $("#cancel-select-icon") as JQuery;

const adminSettingsBtn = $("#admin-settings-btn") as JQuery;
const adminSettingsWindow = $("#admin-settings-window") as JQuery;
const flairUserDropdown = $("#select-flair-user") as JQuery;

const chatHistory = $("#chat-history") as JQuery;
const chatInput = $("#chat-input") as JQuery;
const centerCards = $("#center-cards") as JQuery;
const curBlackCard = $("#cur-black-card") as JQuery;
const centralAction = $("#central-action") as JQuery;
const curCzarText = $("#cur-czar-text") as JQuery;
const hand = $("#hand");

/********************
 * Helper Functions *
 ********************/

function resetRoomMenu() {
  resetIconSelector();
  iconSelector.hide();
  joinOrCreateDialog.show();
  iconBackBtn.show();
  $("#set-username-submit").attr("value", "Set Username");

  window.history.pushState(null, null as any, window.location.href.split("?")[0]);

  roomId = null;
  room = null;
}

function clearResponseCards() {
  centerCards.removeClass("responses-shown").removeClass("czar-mode");
  $("#select-winner").hide();
  $("#response-cards").empty();
  centralAction.hide();
}

function startChoosing() {
  for (const roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.idle) setUserState(roomUser.id, UserState.choosing);
  }

  if (room) room.state = RoomState.choosingCards;
}

function setWinner(winningCards: Record<number, Card>) {
  clearResponseCards();
  centerCards.addClass("winner-shown");
  const count = Object.keys(winningCards).length;

  if (count === 1) appendCard(winningCards[0], curBlackCard);
  else curBlackCard.append(getResponseGroupHTML(0, count, false, winningCards));
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
  likesDiv.children(".msg-heart").first().on("click", () => {
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
    let likesChildren = likesDiv.children();

    if (likesChildren.length < 4) {
      likesDiv.append(`
      <div class="msg-like">
        <i class="fas fa-${user.icon}" title="Liked by ${user.name}"></i>
      </div>
    `);
    } else if (likesChildren.length === 4) {
      likesDiv.append(`
        <div class="excess-likes">
          <span>+1</span>
        </div>
      `);
    } else {
      likesDiv.children(".excess-likes").children("span").text("+" + (message.likes.length - 3));
    }
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
  if (!users.hasOwnProperty(message.userId)) return console.warn("Tried to add a message from unknown user #" + message.userId);

  let user = users[message.userId];

  chatHistory.append(`
    <div class="icon-container msg-container ${message.isSystemMsg ? "system-msg" : "user-msg"} ${room.flaredUser === message.userId ? "flared-user" : ""}" id="msg-${message.id}">
      <div class="icon msg-icon">
        <i class="fas fa-${user.icon}"></i>
      </div>
      <div class="content msg-content">
        <h2>${user.name}</h2>
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
    $("#msg-" + message.id).on("dblclick", () => likeMessage(message));
  }
}

function populateChat(messages: Record<number, Message>) {
  for (let msgId in messages) {
    addMessage(messages[msgId], false);
  }
}

function applyAdminSettings() {
  let flairUserId = flairUserDropdown.val();
  if (flairUserId) {
    socket.emit("applyFlair", {
      userId: flairUserId === "none" ? undefined : parseInt(flairUserId as string)
    }, (response: any) => {
      if (response.error) console.warn("Failed to apply flair to user #" + flairUserId + ":", response.error);
    })
  }

  overlayContainer.hide();
  adminSettingsOpen = false;
}

/*************
 * User List *
 *************/

function getStateString(state: UserState): string {
  switch(state) {
    case UserState.winner:
    case UserState.winnerAndNextCzar:
      return "Winner";
    case UserState.czar:
      return "Card Czar";
    case UserState.idle:
    case UserState.nextCzar:
      return "Ready";
    case UserState.choosing:
      return "Choosing";
    default:
      return "Inactive";
  }
}

function addUser(user: User, flair = false) {
  $("#user-list").append(`
    <div class="icon-container user-display${flair ? " flared-user" : ""}" id="user-${user.id}">
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

  if (user.state === UserState.czar) {
    if (user.id === userId) {
      curCzarText.text("You are the Card Czar");
    } else {
      curCzarText.text(user.name + " is the Card Czar");
    }
  } else if (user.state === UserState.winner || user.state === UserState.winnerAndNextCzar) {
    if (user.id === userId) {
      curCzarText.text("You are the winner!");
    } else {
      curCzarText.text(user.name + " is the winner!");
    }
  }
}

function sortUserList() {
  if (!room) return;
  $("#user-list").empty();

  let activeUsers: Array<User> = [];

  for (const roomUserId in users) {
    let roomUser = users[roomUserId];

    if (roomUser.id === room.flaredUser) addUser(roomUser, true);
    else if (roomUser.state !== UserState.inactive) activeUsers.push(roomUser);
  }

  activeUsers.sort((a, b) => b.score - a.score);

  activeUsers.forEach(roomUser => {
    if (roomUser.icon && roomUser.name) addUser(roomUser);
  });
}

function setUserState(userId: number, state: UserState) {
  users[userId].state = state;
  $("#user-state-" + userId).text(getStateString(state));
}

function clearSelectedCards() {
  const selectedCard = $(".selected-card");
  selectedCard.children(".card-footer").children(".specials").remove();
  selectedCard.removeClass("selected-card");

  selectedCards = {};
}

/**********************
 * Expansion Selector *
 **********************/

function addExpansionSelector(id: string, name: string, selected = false, forAdminPanel = false) {
  $(forAdminPanel ? "#admin-expansions-list" : "#initial-expansions-list").append(`
    <div class="expansion${selected ? " selected" : ""}" id="expansion-${id}">
      <span class="expansion-name">${name}</span>
      </div>
  `);

  if (selected) expansionsSelected.push(id);
  
  // Clicking an expansion will toggle it
  $("#expansion-" + id).on("click", () => {
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

function resetIconSelector() {
  $(".icon.selected").removeClass("selected");
  selectedIcon = null;

  $("#set-icon").prop("disabled", true);
}

function setIcon() {
  if (!selectedIcon || !userId) return;

  iconSelector.hide();
  setupSpinner.show();
  
  socket.emit("setIcon", {
    icon: selectedIcon
  }, (response: any) => {
    setupSpinner.hide();
    if (response.error) {
      console.error("Failed to set icon:", response.error);
      iconSelector.show();
      return;
    }
    $("#set-username").show();
    users[userId].icon = selectedIcon as string;
 });
}

function addIcon(name: string) {
  iconSelector.children("#icons").append(`
    <div class="icon ${name == selectedIcon ? "selected" : ""}" id="icon-${name}">
      <i class="fas fa-${name}"></i>
    </div>
  `);
  // Add a click listener to select the icon
  const element = $("#icon-" + name);
  if (element.length == 0) return console.warn("Failed to get icon " + name);

  element.on("click",() => {
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

  element.on("dblclick", () => {
    setIcon();
  });
}

function populateIconSelector(icons: Array<string>) {
  iconSelector.children("#icons").empty();
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

$("#set-icon").on("click", () => {
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
    let newIcon = undefined;
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

{
  let roomIdStr = helpers.getURLParam("room");
  let roomToken = helpers.getURLParam("token");
  if (roomIdStr && roomToken && parseInt(roomIdStr)) {
    joinOrCreateDialog.hide();
    iconSelector.show();
    iconBackBtn.hide();
  }
}


socket.on("init", (data: any) => {
  if (data.error) return console.error("Failed to initialize socket:", data.error);
  console.debug("Obtained userId " + data.userId + " and token " + data.userToken);
  userId = data.userId;
  userToken = data.userToken;

  let roomIdStr = helpers.getURLParam("room");
  let roomToken = helpers.getURLParam("token");
  let adminToken = helpers.getURLParam("adminToken") || undefined;

  if (roomIdStr && roomToken) {
    roomId = parseInt(roomIdStr);
  }

  users[userId] = new User(userId, false, UserState.idle,undefined, undefined,0);

  if (roomId) {
    console.debug("Trying to join room #" + roomId + " with token #" + roomToken);
    $("#set-username-submit").attr("value", "Join Room");

    setupSpinner.show();

    socket.emit("joinRoom", {
      roomId: roomId,
      token: roomToken,
      adminToken: adminToken
    }, (response: any) => {
      if (response.error) {
        console.warn("Failed to join room #" + roomId + " with token #" + roomToken + ":", response.error);
        setupSpinner.hide();
        resetRoomMenu();
        return;
      }

      joinRoom(response);

      if (adminToken) {
        adminSettingsBtn.show();
        packs = data.packs;
      }

      setupSpinner.hide();
    });
  }
});

function joinRoom(data: any) {
  populateIconSelector(data.iconChoices);
  console.debug("Joined room #" + data.room.id);

  users = data.users;
  room = data.room;

  if (!room) return console.warn("Received invalid room");

  room.link = window.location.href;

  populateChat(room.messages);
  sortUserList();

  if (room.curPrompt) {
    setBlackCard(room.curPrompt);

    if (room.state === RoomState.readingCards && data.responseGroups) {
      const responsesCount = Object.keys(data.responseGroups).length;
      centerCards.addClass("responses-shown");

      const responseCards = $("#response-cards") as JQuery;

      console.debug("Adding response groups:", data.responseGroups);

      for (let groupId = 0; groupId < responsesCount; groupId++) {
        const group = data.responseGroups[groupId];

        if (room.curPrompt.pick === 1) {
          const card = group[0];
          if (card) appendCard(card, responseCards, true, "response-card-" + groupId);
          else responseCards.append(getCardBackHTML("response-card-" + groupId, true, true));
        } else {
          responseCards.append(getResponseGroupHTML(groupId, Object.keys(group).length, false, group));
        }
      }

      if (room.selectedResponse) {
        if (room.curPrompt.pick === 1) $("#response-card-" + room.selectedResponse).addClass("selected-response");
        else $("#response-group" + room.selectedResponse).addClass("selected-group");
      }
    } else if (room.state === RoomState.viewingWinner && data.winningCards) {
      setWinner(data.winningCards);
    }
  }
}

socket.on('reconnect_attempt', () => {
  socket.io.opts.query = {
    userId: userId,
    userToken: userToken
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
  room.open = data.open;
  room.rotateCzar = data.rotateCzar;
  startChoosing();

  if (data.hand) addCardsToDeck(data.hand);
  setBlackCard(data.blackCard);
});

window.addEventListener("beforeunload", () => {
  socket.emit("userLeft");
});

socket.on("applyFlair", (data: any) => {
  if (!room) return console.warn("Received flair update when not in a room");

  if (data.userId === room.flaredUser) return;

  room.flaredUser = data.userId;
  sortUserList();

  chatHistory.empty();
  populateChat(room.messages);
});

/**************
 * Room Setup *
 **************/

$("#create-room-mode").on("click", () => {
  joinOrCreateDialog.hide();
  setupSpinner.show();

  socket.emit("getAvailableIcons", {}, (response: any) => {
    setupSpinner.hide();

    if (response.error) {
      joinOrCreateDialog.show();
      return console.warn("Failed to get available icons:", response.error);
    }

    iconSelector.show();
    populateIconSelector(response.icons);
  });
});

$("#join-room-mode").on("click", () => {
  joinOrCreateDialog.hide();
  setupSpinner.show();

  socket.emit("joinOpenRoom", {}, (response: any) => {
    if (response.error) {
      joinOrCreateDialog.show();
      setupSpinner.hide();
      return console.warn("Failed to join an open room:", response.error);
    }

    let room = response.room;
    let link = window.location.href.split("?")[0] + "?room=" + room.id + "&token=" + room.token;

    roomId = room.id;
    window.history.pushState(null, null as any, link);

    joinRoom(response);

    iconSelector.show();
    setupSpinner.hide();
  });
});

iconBackBtn.on("click", () => {
  if (room) {
    // Delete the client room
    room = null;

    // Re-initialize users array with only the client
    users = {};
    users[userId] = new User(userId, false, UserState.idle,undefined, undefined,0);

    // Remove center cards
    curBlackCard.empty();
    clearResponseCards();

    // Clear hand
    clearSelectedCards();
    hand.empty();

    // Clear user list and top info text
    $("#user-list").empty();
    $("#cur-czar-text").text("");

    // Clear chat
    chatHistory.empty();

    // Inform the server of leave
    socket.emit("leaveRoom");
  }

  resetRoomMenu();
  iconSelector.hide();
  joinOrCreateDialog.show();
});

$("#username-input").on("keyup", () => {
  let userName = ($("#username-input").val() as string).replace(/^\s+|\s+$/g, "");
  $("#set-username-submit").prop("disabled", userName.length === 0);
});

$("#set-username").on("submit", event => {
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

      room = room as Room;
      setupSpinner.hide();

      if (response.error) {
        console.error("Failed to enter room #" + room.id + ":", response.error);
        resetRoomMenu();
        return;
      }

      console.debug("Entered room #" + room.id);
      addCardsToDeck(response.hand);

      overlayContainer.hide();

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
      window.history.pushState(null, null as any, room.link);

      populateChat(room.messages);
      sortUserList();

      setupSpinner.hide();
    });
  }
});

$("#start-game").on("click", () => {
  if (!room) return console.error("Attempted to start game without a room ID");

  console.debug("Starting game...");

  $("#room-setup-window").hide();
  $("#user-setup-window").show();
  setupSpinner.show();

  const title = $("#settings-title");
  title.children("h1").text("Configuring Room...");
  title.children("p").text("Please wait a second.");
  title.show();

  let edition = $("#select-edition").val();
  let rotateCzar = $("#select-czar").val() === "rotate";
  let open = $("#select-privacy").val() === "public";

  socket.emit("roomSettings", {
    edition: edition,
    rotateCzar: rotateCzar,
    open: open,
    packs: expansionsSelected
  }, (response: any) => {
    setupSpinner.hide();

    if (response.error) {
      $("#room-setup-window").show();
      $("#user-setup-window").hide();
      return console.warn("Failed to setup room:", response.error);
    }

    $("#initial-expansions-list").empty();

    startChoosing();
    addCardsToDeck(response.hand);
    setBlackCard(response.blackCard);

    title.children("h1").text("Room Created!");
    title.children("p").text("Send your friends the link to add them.");

    $("#room-link-window").show();
    $("#room-link-box-text").text(room ? (room.link as string) : "Error");
  });
});

$("#enter-room").on("click", () => {
  overlayContainer.hide();
});

// We can't use => since we need access to 'this'
$(".room-link").on("click", function() {
  if (!room || !room.link) return console.warn("Not in a room!");

  // Actually copy the link
  $("body").append(`<textarea id="fake-for-copy" readonly>${room.link}</textarea>`);
  let fake = $("#fake-for-copy")[0];

  // @ts-ignore
  fake.select();
  document.execCommand("copy");
  fake.remove();

  // "Link Copied!" notification logic
  $(this).parent().append(`
    <div class="link-copy-notification" style="display: none;">Link Copied!</div>
  `);
  $(".link-copy-notification").show().css("opacity", 100).removeClass("visible");
  if (copyLinkFadeTimer) clearTimeout(copyLinkFadeTimer);
  if (copyLinkPersitTimer) clearTimeout(copyLinkPersitTimer);
  copyLinkPersitTimer = setTimeout(() => {
    $(".link-copy-notification").css("opacity", 0).addClass("visible");
    if (copyLinkFadeTimer) clearTimeout(copyLinkFadeTimer);
    copyLinkFadeTimer = setTimeout(() => {
      $(".link-copy-notification").remove();
    }, 2000);
  }, 1000);
});

/***************
 * Chat System *
 ***************/

chatInput.on("keyup", event => {
  event.stopPropagation();

  let content = chatInput.val();
  if (typeof content !== "string") return;

  let contentStripped = content.replace(/^\s+|\s+$/g, "");

  // 13 is the keycode for enter
  if (contentStripped.length > 0 && event.which === 13) {
    socket.emit("chatMessage", {
      content: contentStripped
    }, (response: any) => {
      chatInput.val("");
      if (response.error) return console.warn("Failed to send chat message:", response.error);
      if (response.message) addMessage(response.message);
    });

  }
});

$(window).on("resize", () => {
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

socket.on("userState", (data: any) => {
  setUserState(data.userId, data.state);
});

socket.on("answersReady", (data: any) => {
  if (!room) return console.warn("Received answersReady when not in a room");
  else if (users[userId].state !== UserState.czar) return console.warn("Received answersReady state despite not being czar");
  else if (room.state !== RoomState.choosingCards) return console.warn("Received answersReady when room was in state #" + room.state);
  if (data.count >= 2) {
    centralAction.show().text("Read Answers (" + data.count + "/" + data.maxResponses + ")");
  } else centralAction.hide();
});

socket.on("answersNotReady", () => {
  if (!room) return console.warn("Received answersNotReady when not in a room");
  else if (users[userId].state !== UserState.czar) return console.warn("Received answersNotReady state despite not being czar");
  else if (room.state !== RoomState.choosingCards) return console.warn("Received answersNotReady when room was in state #" + room.state);
  centralAction.hide();
});

socket.on("skipPrompt", (data: any) => {
  if (!room) return console.warn("Tried to skip prompt when not in a room");

  if (data.newPrompt) {
    centralAction.hide();
    clearSelectedCards();

    room.curPrompt = data.newPrompt;
    setBlackCard(data.newPrompt);

    if (data.message) addMessage(data.message);
  }
});

socket.on("startReadingAnswers", (data: any) => {
  if (!room || !room.curPrompt) return console.warn("Tried to start reading answers when not in a room");

  clearSelectedCards();
  centralAction.hide();

  room.state = RoomState.readingCards;
  let isCzar = users[userId].state === UserState.czar;

  for (let roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.choosing) setUserState(roomUser.id, UserState.idle);
  }

  centerCards.addClass("responses-shown");
  const responseSize = room.curPrompt.pick;

  for (let i = 0; i < data.groups; i++) {
    if (responseSize === 1) addResponseCard(i, isCzar);
    else addResponseGroup(i, responseSize, isCzar);
  }
});

socket.on("revealResponse", (data: any) => {
  if (!room || !room.curPrompt) return console.warn("Tried to reveal a response without a room/prompt");

  let cardElement = $("#response-card-" + ((data.group * room.curPrompt.pick) + data.num));
  cardElement.removeClass("back").addClass("front");
  cardElement.children(".card-text").text(data.card.text);
  cardElement.append(`<div class="card-footer"><div class="footer-text">Cards Against Quarantine</div></div>`);

  if (users[userId].state === UserState.czar) {
    cardElement.addClass("no-hover");
    cardElement.off("click");

    // If there are multiple responses, selection is handled by the group
    if (room.curPrompt.pick === 1) {
      cardElement.on("click", () => {
        socket.emit("selectResponseGroup", {group: data.group}, (response: any) => {
          if (response.error) return console.warn("Failed to select response:", response.error);
        });
      });
    }
  }
});

socket.on("selectResponseGroup", (data: any) => {
  if (!room || !room.curPrompt) return console.warn("Tried to select response group without valid room/prompt");

  selectedGroup = data.group;

  if (selectedGroup !== null && users[userId].state === UserState.czar) {
    $("#select-winner").show();
    centerCards.addClass("czar-mode");
  }

  if (room.curPrompt.pick === 1) {
    $(".selected-response").removeClass("selected-response");
    if (data.group !== null) $("#response-card-" + data.group).addClass("selected-response");
  } else {
    $(".selected-group").removeClass("selected-group");
    if (data.group !== null) $("#response-group-" + data.group).addClass("selected-group");
  }
});

socket.on("selectWinner", (data: any) => {
  if (!room) return console.warn("Tried to select winner when not in a room");

  users[data.winnerId].score += 1;

  for (const roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.inactive) continue;
    if (roomUser.id === data.winnerId) {
      if (!room.rotateCzar || roomUser.id === data.nextCzarId) roomUser.state = UserState.winnerAndNextCzar;
      else roomUser.state = UserState.winner;
    } else if (roomUser.id === data.nextCzarId) roomUser.state = UserState.nextCzar;
    else roomUser.state = UserState.idle;
  }

  sortUserList();

  room.state = RoomState.viewingWinner;

  setWinner(data.winningCards);

  // Show the 'next round' button if we are the next czar
  if (data.nextCzarId === userId) {
    centralAction.show().text("Next Round");
  }
});

socket.on("nextRound", (data: any) => {
  if (!room) return console.warn("Tried to start next round when not in a room");
  console.debug("Starting next round with user #" + data.czar + " as the card czar");

  room.state = RoomState.choosingCards;
  for (const roomUserId in users) {
    let roomUser = users[roomUserId];
    if (roomUser.state === UserState.inactive) continue;
    users[roomUser.id].state = roomUser.id === data.czar ? UserState.czar : UserState.choosing;
  }

  sortUserList();

  clearResponseCards();
  centerCards.removeClass("winner-shown");

  if (data.card) setBlackCard(data.card);
});

/********************
 * Card Interaction *
 ********************/

function getCardBackHTML (id: string, isWhite = true, noHover = false): string {
  return `
    <div class="card ${isWhite ? "white" : "black"} back ${noHover ? "no-hover" : ""}" id="${id}">
      <div class="card-text">Cards Against Quarantine</div>
    </div>
  `;
}

function registerResponse(group: number, num: number, groupSize: number) {
  $("#response-card-" + ((group * groupSize) + num)).on("click", (event) => {
    // Prevents the response group being selected if we are only revealing a response
    event.stopPropagation();

    socket.emit("revealResponse", {group: group, num: num}, (response: any) => {
      if (response.error) return console.warn("Failed to reveal response #" + num + " from group #" + group + ":", response.error);
    });
  });
}

function addResponseCard(id: number, isCzar: boolean) {
  $("#response-cards").append(getCardBackHTML("response-card-" + id, true, !isCzar));

  // Only the czar can reveal answers
  if (isCzar) registerResponse(id, 0, 1);
}

function getResponseGroupHTML(id: number, size: number, enableHover: boolean, cards?: Record<number, Card>): string {
  let html = `<div class="response-group ${enableHover ? "" : "no-hover"}" id="response-group-${id}">`;
  for (let card = 0; card < size; card++) {
    const realId = (id * size + card);
    if (cards && cards[card]) {
      html += getCardHTML(cards[card], true, "response-card-" + realId, true);
    } else {
      html += getCardBackHTML("response-card-" + realId, true, !enableHover);
    }
  }
  html += `</div>`;
  return html;
}

function addResponseGroup(id: number, size: number, isCzar: boolean) {
  $("#response-cards").append(getResponseGroupHTML(id, size, isCzar));

  if (isCzar) {
    for (let card = 0; card < size; card++) registerResponse(id, card, size);
    $("#response-group-" + id).on("click", () => {
      console.debug("Selected response group #" + id);
      socket.emit("selectResponseGroup", {group: id}, (response: any) => {
        if (response.error) return console.warn("Failed to select response group #" + id + ":", response.error);
      })
    });
  }
}

function getCardHTML(card: any, isWhite = true, id?: string, noHover = false) {
  let color = isWhite ? "white" : "black";
  if (!id) id = color + "-card-" + card.id;

  let html = `
    <div class="card ${color} front ${noHover ? "no-hover" : ""}" id="${id}">
      <div class="card-text">${card.text}</div>
      <div class="card-footer">
        <div class="footer-text">Cards Against Quarantine</div>
  `;

  if (card.pick) {
    html += `<div class="specials">`;

    if (card.draw > 0) {
      html += `
        <div class="special special-draw">
          <div class="special-text">DRAW</div>
          <div class="special-number">${card.draw}</div>
        </div>
      `;
    }

    if (card.pick > 1) {
      html += `
      <div class="special special-pick">
        <div class="special-text">PICK</div>
        <div class="special-number">${card.pick}</div>
      </div>
    `;
    }

    html += `</div>`;
  }

  return html + `</div></div>`;
}
function appendCard(card: any, target: JQuery, isWhite=true, id?: string) {
  target.append(getCardHTML(card, isWhite, id));
}

function selectFirstCard(cardId: number) {
  clearSelectedCards();
  selectedCards[0] = cardId;
}

function addSelectIndicator(cardElement: JQuery, num: number) {
  const footer = cardElement.children(".card-footer");
  const specials = footer.children(".specials");

  // It's just easier to simply remove the existing specials div
  if (specials.length > 0) specials.remove();

  footer.append(`
    <div class="specials">
      <div class="special special-select">
        <div class="special-number">${num}</div>
      </div>
    </div>
  `);
}

// TODO: animate?
function addCardToDeck(card: Card) {
  appendCard(card, hand);
  let cardElement = $("#white-card-" + card.id);
  cardElement.on("click", () => {
    if (!room || !room.curPrompt) return;
    if (users[userId].state !== UserState.choosing || submittingCards) return;

    let pick = room.curPrompt.pick;
    let picked = Object.keys(selectedCards).length;
    let allowSubmit = false;

    if (pick === 1) {
      selectFirstCard(card.id);
      allowSubmit = true;
    } else if (pick === 2) {
      if (picked === 0) {
        selectFirstCard(card.id);
        addSelectIndicator(cardElement, 1);
      } else if (picked === 1) {
        // Can't select the same card twice
        if (selectedCards[0] === card.id) {
          console.debug("reselect");
          return;
        } else {
          selectedCards[1] = card.id;
          addSelectIndicator(cardElement, 2);
          allowSubmit = true;
        }
      } else if (picked > 1) {
        let oldFirst = selectedCards[0];
        let newFirst = selectedCards[1];

        clearSelectedCards();

        // Swap the order if one of the cards was already selected
        if (newFirst === card.id) newFirst = oldFirst;

        selectedCards[0] = newFirst;
        selectedCards[1] = card.id;

        const newFirstElement = $("#white-card-" + newFirst);
        newFirstElement.addClass("selected-card");

        addSelectIndicator(newFirstElement, 1);
        addSelectIndicator(cardElement, 2);

        allowSubmit = true;
      }
    }

    cardElement.addClass("selected-card");
    if (allowSubmit) showSubmitBtn();
  });
}

function addCardsToDeck(newCards: Record<number, Card>) {
  $("#hand-settings").removeClass("no-cards");
  for (let cardId in newCards) {
    addCardToDeck(newCards[cardId]);
  }
}

function setBlackCard(blackCard: BlackCard) {
  if (!room) return console.warn("Tried to set black card when not in a room!");

  room.curPrompt = blackCard;
  curBlackCard.empty();
  appendCard(blackCard, curBlackCard, false);

  if (users[userId].state === UserState.czar) {
    centralAction.show().text("Skip Card");
  }
}

function showSubmitBtn() {
  if (!room || !room.curPrompt) return;

  centralAction.show().text("Submit Card" + (room.curPrompt.pick > 1 ? "s" : ""));
}

hand.sortable({
  tolerance: "pointer"
});

$("#game-wrapper").on("click",event => {
  if (!room) return;

  if (!submittingCards && ($(event.target).is("#game-wrapper") ||
      $(event.target).is(hand) ||
      $(event.target).is("#response-cards") ||
      $(event.target).is(centerCards))) {

    if (room.state === RoomState.readingCards) {
      // Technically an admin could do this too but it seems unnecessary
      if (users[userId].state === UserState.czar) {
        $("#select-winner").hide();
        centerCards.removeClass("czar-mode");
        socket.emit("selectResponseGroup", {group: null}, (response: any) => {
          if (response.error) return console.warn("Failed to deselect card:", response.error);
        });
      }
    } else if (Object.keys(selectedCards).length > 0) {
      clearSelectedCards();
      centralAction.hide();
    }
  }
});

overlayContainer.on("click", event => {
  if (!adminSettingsOpen) return;

  if ($(event.target).is(overlayContainer)) {
    applyAdminSettings();
  }
});

function submitCards() {
  if (!room || !room.curPrompt) return;

  const submissionCards = Object.assign({}, selectedCards);

  centralAction.hide();
  if (Object.keys(selectedCards).length === room.curPrompt.pick && !submittingCards) {
    submittingCards = true;
    socket.emit("submitCards", {
      cards: submissionCards
    }, (response: any) => {
      submittingCards = false;
      if (response.error) {
        console.warn("Failed to submit cards:", submissionCards, response.error);
        return showSubmitBtn();
      }

      for (const pos in submissionCards) {
        $("#white-card-" + submissionCards[pos]).remove();
      }
      clearSelectedCards();
      if (response.newCards) addCardsToDeck(response.newCards);
      setUserState(userId, UserState.idle);
    });
  }
}

centralAction.on("click", () => {
  if (!room) return console.warn("Central action button clicked when not in a room");
  let curState = users[userId].state;

  // Go to the next round if 'Next Round' button is shown
  if (room.state === RoomState.viewingWinner) {
    if (curState !== UserState.nextCzar && curState != UserState.winnerAndNextCzar) {
      return console.warn("User who is not selected as next czar tried to start next round!");
    }
    socket.emit("nextRound", {}, (response: any) => {
      if (response.error) return console.warn("Failed to start the next round:", response.error);
      centralAction.hide();
    });
    return;
  }

  if (curState === UserState.czar) {
    let submittedResponses = 0;
    for (const roomUserId in users) {
      let roomUser = users[roomUserId];
      if (roomUser.state === UserState.idle) submittedResponses++;
    }
    if (submittedResponses >= 2) {
      // Start reading answers if two or more responses
      socket.emit("startReadingAnswers", {}, (response: any) => {
        if (response.error) return console.warn("Failed to start reading answers:", response.error);
        centralAction.hide();
      });
    } else {
      // Skip card if less than two responses
      socket.emit("skipPrompt", {}, (response: any) => {
        if (response.error) return console.warn("Failed to skip prompt:", response.error);
      });
    }
  } else if (curState === UserState.choosing) {
    submitCards();
  }
});

$("#select-winner").on("click", () => {
  if (users[userId].state === UserState.czar && selectedGroup !== null) {
    socket.emit("selectWinner", {group: selectedGroup}, (response: any) => {
      if (response.error) return console.warn("Failed to select winning group:", response.error);
    })
  }
});

$("#recycle-hand").on("click", () => {
  if (recyclingCards) return;
  else if (!room || room.state === RoomState.new) return console.warn("Can't recycle hand before room is setup!");

  recyclingCards = true;
  $("#recycle-hand").children("i").addClass("fa-spin");
  socket.emit("recycleHand", (response: any) => {
    $("#recycle-hand").children("i").removeClass("fa-spin");
    recyclingCards = false;
    if (response.error) return console.warn("Failed to recycle hand:", response.error);
    if (response.cards) {
      hand.empty();
      addCardsToDeck(response.cards);
    }
    if (response.message) addMessage(response.message);
  });
});

adminSettingsBtn.on("click", () => {
  if (!room) return console.warn("Can't use admin settings when not in a room!");
  if (!users[userId].admin) return console.warn("Only admins can access admin settings!");

  // Ensure that only the admin settings window is visible
  $("#room-setup-window").hide();
  $("#user-setup-window").hide();
  adminSettingsWindow.show();

  // Repopulate user flair dropdown
  flairUserDropdown.empty();
  flairUserDropdown.append(`<option value="none">None</option>`);
  for (const roomUserId in users) {
    const roomUser = users[roomUserId];
    if (!roomUser.name || roomUser.state === UserState.inactive) continue;
    flairUserDropdown.append(`
      <option value="${roomUser.id}" ${roomUser.id === room.flaredUser ? "selected" : ""}>${roomUser.name}</option>
    `);
  }

  // Repopulate admin expansions list
  expansionsSelected = [];
  $("#admin-expansions-list").empty();
  for (const packId in packs) {
    const pack = packs[packId];
    addExpansionSelector(pack.id, pack.name, pack.enabled, true);
  }

  overlayContainer.show();
  adminSettingsOpen = true;
});

$("#apply-admin-settings").on("click", () => {
  applyAdminSettings();
});
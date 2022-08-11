var io = require('socket.io-client');
var fs = require('fs');

let custom_game_id = undefined;
let user_config =  undefined;
let user_config_filename = undefined;
if (process.argv.length > 2) {
	custom_game_id = process.argv[2]
} else {
	throw 'custom game id must be set as first command line argument';
}
if (process.argv.length > 3) {
	user_config_filename = process.argv[3]
	try {
		user_config = require(user_config_filename);
		if (!('username' in user_config)) { throw 'custom user_configs must contain username'; }
		if (!('user_id' in user_config)) { throw 'user_config must contain user_id'; }
		console.log(`Using config ${user_config_filename}.`);
		console.log(`Playing as ${user_config['username']}.`);
	} catch {
		console.log(`Error reading from user_config ${user_config_filename}`);
		user_config = undefined;
	}
}
if (user_config === undefined) {
	console.log('No user_config specified. Creating random user_id.');
	console.log('Joining as Anonymous.');
	function randomChoice(arr) { return arr[Math.floor(arr.length * Math.random())];}
	const user_id_chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
	let user_id = '';
	for(let i = 0; i < 16; i++) { user_id += randomChoice(user_id_chars); }
	user_config = { user_id };
}

const FORCE_START_INTERVAL_MS = 5000;
var force_start_interval;


var socket = io('https://bot.generals.io');

socket.on('disconnect', function() {
	console.error('Disconnected from server.');
	process.exit(1);
});

socket.on('error_set_username', function(error_message) {
	if (error_message) {
		console.log('Error setting message:');
		console.log(error_message)
	} else {
		console.log(`Username successfully set! Recording this in config.`);
		fs.writeFile(user_config_filename,
			JSON.stringify({ ...user_config, has_username_been_set: true }, null, 4),
			function (err) { if (err) { console.log(err); } else { console.log(`${user_config_filename} updated.`); } }
		);
	}
});

socket.on('connect', function() {
	console.log('Connected to server.');

	if ('username' in user_config && !('has_username_been_set' in user_config)) {
		// Set the username for the bot.
		// This should only ever be done once. See the API reference for more details.
		socket.emit('set_username', user_config['user_id'], user_config['username']);
	}

	// Custom games are a great way to test your bot while you develop it because you can play against your bot!
	socket.emit('join_private', custom_game_id, user_config['user_id']);
	// Join a custom game and ready up every so often until the game starts.
	// Doing this multiple times is only necessary if something about the game changes (like players switching teams)
	// after the inital ready-up, in which case all previously ready players need to ready-up again.
	force_start_interval = setInterval(() => {
		socket.emit('set_force_start', custom_game_id, true);
	}, FORCE_START_INTERVAL_MS);

	console.log('Joined custom game at http://bot.generals.io/games/' + encodeURIComponent(custom_game_id));

	// When you're ready, you can have your bot join other game modes.
	// Here are some examples of how you'd do that:

	// Join the 1v1 queue.
	// socket.emit('join_1v1', user_config['user_id']);

	// Join the FFA queue.
	// socket.emit('play', useuser_config['user_id']r_id);

	// Join a 2v2 team.
	// socket.emit('join_team', 'team_name', user_config['user_id']);
});

// Terrain Constants.
// Any tile with a nonnegative value is owned by the player corresponding to its value.
// For example, a tile with value 1 is owned by the player with playerIndex = 1.
const TILE_EMPTY = -1;
const TILE_MOUNTAIN = -2;
const TILE_FOG = -3;
const TILE_FOG_OBSTACLE = -4; // Cities and Mountains show up as Obstacles in the fog of war.

// Game data.
var playerIndex;
var generals; // The indicies of generals we have vision of.
// Map is the main piece of data updated with each game_update.
// It is then split into terrain and armies, which are more recommendable for use.
var map = [];
var map_height;
var map_width;
// Terrain and armies both represents the entire grid of size map_width x map_height.
var terrain; // Terrain includes obstacles and the player indices on owned tiles. See Terrain Constants above.
var armies; // 0s execpt for army values of all players. Cities have "neutral" armies and show up as such here.
var cities = []; // The indicies of cities we have vision of.


/**
 * Takes a 1d array, such as terrain or armies and prints it to the console in a compact manner to facilitate debugging.
 */
let print_as_grid = (array, width=map_width, print_axes=true) => {
	if (array.length % width !== 0) {
		console.log(`Array of length ${array.length} is not rectangular with width of ${width}.`)
		return;
	}
	if (print_axes) {
		array = array.slice();
		array.unshift(...[...Array(width).keys()].map(e => e+1));
	}
	print_width = Math.max(...array.map(value => String(value).length))
	output = ''
	for (let i = 0; i < Math.floor(array.length / width); i ++) {
		output +=
			(i > 0 ? '\n' : '') +
			[...(print_axes ? [i > 0 ? i : ' '] : []),
			...array.slice(i * width, (i + 1) * width)].map(value => String(value).padEnd(print_width)).join(' ')
	}
	console.log(output)
}

/* Returns a new array created by patching the diff into the old array.
 * The diff formatted with alternating matching and mismatching segments:
 * <Number of matching elements>
 * <Number of mismatching elements>
 * <The mismatching elements>
 * ... repeated until the end of diff.
 * Example 1: patching a diff of [1, 1, 3] onto [0, 0] yields [0, 3].
 * Example 2: patching a diff of [0, 1, 2, 1] onto [0, 0] yields [2, 0].
 */
function patch(old, diff) {
	var out = [];
	var i = 0;
	while (i < diff.length) {
		if (diff[i]) {  // matching
			Array.prototype.push.apply(out, old.slice(out.length, out.length + diff[i]));
		}
		i++;
		if (i < diff.length && diff[i]) {  // mismatching
			Array.prototype.push.apply(out, diff.slice(i + 1, i + 1 + diff[i]));
			i += diff[i];
		}
		i++;
	}
	return out;
}

socket.on('game_start', function(data) {
	// No longer need to keep sending force_start.
	clearInterval(force_start_interval);

	// Get ready to start playing the game.
	playerIndex = data.playerIndex;
	var replay_url = 'http://bot.generals.io/replays/' + encodeURIComponent(data.replay_id);
	console.log('Game starting! The replay will be available after the game at ' + replay_url);
});

socket.on('game_update', function(data) {
	// Patch the city and map diffs into our local variables.
	cities = patch(cities, data.cities_diff);
	map = patch(map, data.map_diff);
	generals = data.generals;

	// The first two terms in |map| are the dimensions.
	map_width = map[0];
	map_height = map[1];
	var size = map_width * map_height;

	// The next |size| terms are army values.
	// armies[0] is the top-left corner of the map.
	armies = map.slice(2, size + 2);

	// The last |size| terms are terrain values.
	// terrain[0] is the top-left corner of the map.
	terrain = map.slice(size + 2, size + 2 + size);

	print_as_grid(terrain);

	// Make a random move.
	while (true) {
		// Pick a random tile.
		var index = Math.floor(Math.random() * size);

		// If we own this tile, make a random move starting from it.
		if (terrain[index] === playerIndex) {
			var row = Math.floor(index / map_width);
			var col = index % map_width;
			var endIndex = index;

			var rand = Math.random();
			if (rand < 0.25 && col > 0) { // left
				endIndex--;
			} else if (rand < 0.5 && col < map_width - 1) { // right
				endIndex++;
			} else if (rand < 0.75 && row < map_height - 1) { // down
				endIndex += map_width;
			} else if (row > 0) { //up
				endIndex -= map_width;
			} else {
				continue;
			}

			// Would we be attacking a city? Don't attack cities.
			if (cities.indexOf(endIndex) >= 0) {
				continue;
			}

			socket.emit('attack', index, endIndex);
			break;
		}
	}
});

function leaveGame() {
	socket.emit('leave_game');
}

socket.on('game_lost', leaveGame);

socket.on('game_won', leaveGame);
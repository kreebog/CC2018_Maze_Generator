require('dotenv').config();
import fs from 'fs';
import path from 'path';
import { format } from 'util';
import express from 'express';
import { Server } from 'http';
import { MongoClient } from 'mongodb';

import { Maze, Logger, IMaze } from 'cc2018-ts-lib';

// get singleton logger instance
const log = Logger.getInstance();
log.setLogLevel(parseInt(process.env['LOG_LEVEL'] || '3')); // defaults to "INFO"

// constants from environment variables (or .env file)
const NODE_ENV = process.env['NODE_ENV'] || 'PROD';
const DB_NAME = 'cc2018';
const DB_URL = format('%s://%s:%s@%s/', process.env['DB_PROTOCOL'], process.env['DB_USER'], process.env['DB_USERPW'], process.env['DB_URL']);
const SVC_PORT = process.env.MAZE_SVC_PORT || 8080;
const DELETE_PASSWORD = process.env.DELETE_PASSWORD;
const APP_VERSION = getPackageVersion();
log.info(__filename, '', 'Starting Game Server v' + APP_VERSION);

// general constant values
const COL_NAME = 'mazes';
const SVC_NAME = 'maze-service';

// create express references
const app = express();
let httpServer: Server; // will be set with app.listen
let mongoDBClient: MongoClient; // set on successful connection to db

// configure pug
app.set('views', 'views');
app.set('view engine', 'pug');

// log the environment
log.info(__filename, SVC_NAME, 'Starting service with environment settings for: ' + NODE_ENV);

// only start the web service after connecting to the database
log.info(__filename, SVC_NAME, 'Connecting to MongoDB: ' + DB_URL);
MongoClient.connect(
    DB_URL,
    function(err, client) {
        if (err) {
            log.error(__filename, SVC_NAME, format('Error connecting to %s:\n%s', DB_URL, JSON.stringify(err)));
            return err;
        }

        mongoDBClient = client;

        // get the cc2018 database and the mazes collection
        let db = client.db(DB_NAME);
        let col = db.collection(COL_NAME);

        // all is well, listen for connections
        httpServer = app.listen(SVC_PORT, function() {
            log.info(__filename, SVC_NAME, 'Listening on port ' + SVC_PORT);

            // allow CORS for this application
            app.use(function(req, res, next) {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
                next();
            });

            // accepts MazeID (string concatenation of Height:Width:Seed)
            app.get('/get/:mazeId', (req, res) => {
                let mazeId = req.params.mazeId;

                // search the collection for a maze with the right id
                col.find({ id: mazeId }).toArray((err, docs) => {
                    if (err) {
                        log.error(__filename, req.path, JSON.stringify(err));
                        return res.status(500).json({ status: format('Error finding "%s" in "%s": %s', mazeId, COL_NAME, err.message) });
                    }

                    // warn if there are duplicates - we'll only work with the first record found
                    if (docs.length > 1) {
                        log.warn(__filename, req.path, format('%d mazes found with id "%s", returning first match.', docs.length, mazeId));
                    }

                    // if no match found, generate a new maze from the given values
                    if (docs.length == 0) {
                        log.debug(__filename, req.path, format('Maze "%s" not found.', mazeId));
                        res.status(404).json({ status: format('Maze "%s" not found.', mazeId) });
                    } else {
                        // match was found in the database return it as json
                        log.debug(__filename, req.path, format('Maze "%s" found, return as JSON...', mazeId));

                        // send the first matching maze doc
                        try {
                            res.status(200).json(docs[0]);
                        } catch {
                            res.status(500).json({
                                status: 'Unable to load maze from JSON.',
                                data: JSON.stringify(docs[0])
                            });
                        }
                    }
                });
            });

            // Left in for backward compatibility, builds mazeId from original /get/h/w/seed format and redirects
            // to new /get/mazeId route
            app.get('/get/:height/:width/:seed', (req, res) => {
                log.debug(__filename, req.path, 'Deprecated route - redirecting to /get/mazeId...');
                let mazeId = format('%d:%d:%s', req.params.height, req.params.width, req.params.seed);
                return res.redirect('/get/' + mazeId);
            });

            // gets all mazes
            app.get('/get', (req, res) => {
                // finds all mazes, but only returns basic maze key information
                col.find({}, { fields: { _id: 0, id: 1, height: 1, width: 1, seed: 1 } }).toArray((err, docs) => {
                    if (err) {
                        log.error(__filename, req.path, JSON.stringify(err));
                        return res.status(500).json({
                            status: format('Error finding getting mazes from "%s": %s', COL_NAME, err.message)
                        });
                    }

                    // if no match found, generate a new maze from the given values
                    if (docs.length == 0) {
                        log.debug(__filename, req.path, format('No mazes found in collection %s', COL_NAME));
                        res.status(404).json({ status: format('No mazes found in collection %s', COL_NAME) });
                    } else {
                        // match was found in the database return it as json
                        log.debug(__filename, req.path, format('%d mazes found in %s, returning JSON ...', docs.length, COL_NAME));

                        // construct an array with key maze properties and a get url
                        let mazes = new Array();
                        docs.forEach(doc => {
                            let stub = {
                                id: doc.id,
                                height: doc.height,
                                width: doc.width,
                                seed: doc.seed,
                                url: format('http://%s/get/%d/%d/%s', req.headers.host, doc.height, doc.width, doc.seed)
                            };

                            mazes.push(stub);
                        });

                        // send the json data
                        res.status(200).json(mazes);
                    }
                });
            });

            // gets maze with the given id (combination of height:width:seed)
            app.get('/generate/:height/:width/:seed/:challengeLevel', (req, res) => {
                let mazeId: string = format('%d:%d:%s', req.params.height, req.params.width, req.params.seed);
                let challenge: number = parseInt(req.params.challengeLevel);

                // search the collection for a maze with the right id
                col.find({ id: mazeId }).toArray((err, docs) => {
                    if (err) {
                        log.error(__filename, req.path, JSON.stringify(err));
                        return res.status(500).json({ status: format('Error finding "%s" in "%s": %s', mazeId, COL_NAME, err.message) });
                    }

                    // warn if there are duplicates - we'll only work with the first record found
                    if (docs.length > 0) {
                        log.warn(__filename, req.path, format('%d maze(s) found with id "%s", aborting.', docs.length, mazeId));
                        return res.status(400).json({ status: format('Maze "%s" already exists.', mazeId) });
                    }

                    // if no match found, generate a new maze from the given values
                    log.debug(__filename, req.path, format('Generating maze "%s"...', mazeId));

                    // error handling and input checks are in the Maze class - descriptive error will be returned
                    try {
                        let maze = new Maze().generate(req.params.height, req.params.width, req.params.seed, req.params.challengeLevel);
                        log.debug(__filename, req.path, format('Maze "%s" generated.  Storing...', mazeId));
                        col.insert(maze);

                        log.debug(__filename, req.path, format('Returning Maze "%s" as JSON...', mazeId));
                        res.status(200).json(maze);
                    } catch (error) {
                        log.error(__filename, req.path, format('Error during maze generation: %s', error.message));
                        res.status(500).json({
                            status: format('Error finding "%s" in "%s": %s', mazeId, COL_NAME, error.message)
                        });
                    }
                });
            });

            app.get(['/generate/:mazeId', '/generate/:height/:width/:seed'], (req, res) => {
                res.status(400).json({ status: 'Deprecated. Please use /generate/mazeId/challengeLevel' });
            });

            app.get('/generate/:mazeId/:challengeLevel', (req, res) => {
                log.debug(__filename, req.url, 'Attempting to parse and redirect single mazeId parameter for /generate.');
                try {
                    let mazeId: string = req.params.mazeId;
                    let mazeIdParts = mazeId.split(':');
                    let challengeLevel: string = req.params.challengeLevel;
                    let newUrl = format('/generate/%d/%d/%s', parseInt(mazeIdParts[0]), parseInt(mazeIdParts[1]), mazeIdParts[2]);
                    res.redirect(newUrl);
                } catch (err) {
                    res.status(500).json({ status: 'Unable generate maze. Bad URL? Expected format: /generate/H:W:Seed/ChallengeLevel' });
                }
            });

            /**
             * Lists all mazes currently in the database
             * TODO: Page this?  It might get long...
             */
            app.get('/list', (req, res) => {
                col.find({}).toArray((err, docs) => {
                    if (err) {
                        log.error(__filename, req.path, JSON.stringify(err));
                        return res.status(500).json({
                            status: format('Error getting all documents from "%s": %s', COL_NAME, err.message)
                        });
                    }

                    res.render('list', {
                        contentType: 'text/html',
                        responseCode: 200,
                        mazes: docs,
                        title: 'List Mazes'
                    });
                });
            });

            /**
             * Renders a simple view of the maze
             */
            app.get('/view/:mazeId', (req, res) => {
                let mazeId = req.params.mazeId;

                // only need one maze here, and we have to strop the _id (mongo doc id) so that
                // it will match the signature of IMaze
                col.findOne({ id: mazeId }, { projection: { _id: 0 } }, (err, doc) => {
                    if (err) {
                        log.error(__filename, req.path, JSON.stringify(err));
                        return res.status(500).json({ status: format('Error finding "%s" in "%s": %s', mazeId, COL_NAME, err.message) });
                    }

                    if (!doc || doc === undefined) {
                        log.debug(__filename, req.path, format('No maze with id %s found.', mazeId));
                        return res.status(404).json({ status: format('Maze "%s%" not found.', mazeId) });
                    } else {
                        log.debug(__filename, req.path, format('Maze "%s" found in DB, viewing...', mazeId));

                        // load up the maze class - need some data from it
                        let maze: IMaze = doc;

                        res.status(200).render('view', {
                            contentType: 'text/html',
                            maze: maze,
                            title: 'View Maze'
                        });
                    }
                });
            });

            /**
             * Deletes maze documents with matching ID
             */
            app.get('/delete/:mazeId/:password', (req, res) => {
                let mazeId = req.params.mazeId;

                // PASSWORD FOR DELETES FOUND IN ENVIRONMENT VARIABLES
                if (DELETE_PASSWORD != req.params.password) return res.status(401).json({ status: 'Missing or incorrect password.' });

                // delete the first document with the matching mazeId
                col.deleteOne({ id: mazeId }, function(err, results) {
                    if (err) {
                        log.error(__filename, req.path, JSON.stringify(err));
                        return res.status(500).json({ status: format('Error finding "%s" in "%s": %s', mazeId, COL_NAME, err.message) });
                    }

                    // send the result code with deleted doc count
                    res.status(200).json({ status: 'ok', count: results.deletedCount });
                    log.info(__filename, req.path, format('%d document(s) deleted', results.deletedCount));
                });
            });

            /**
             * Handle favicon requests - using the BCBST favicon.ico
             */
            app.get('/favicon.ico', (req, res) => {
                res.setHeader('Content-Type', 'image/x-icon');
                res.status(200).sendFile(path.resolve('views/favicon.ico'));
            });

            /**
             * Mis-routed traffic catch-all
             */
            app.get('/*', (req, res) => {
                log.debug(__filename, req.path, 'Unhandled route - redirecting to index.html.');
                res.setHeader('Content-Type', 'text/html');
                res.render('index', {
                    contentType: 'text/html',
                    responseCode: 404,
                    sampleGetAll: format('http://%s/get', req.headers.host),
                    sampleGet: format('http://%s/get/10:15:SimpleSample', req.headers.host),
                    sampleGenerate: format('http://%s/generate/10/15/SimpleSample/1', req.headers.host),
                    sampleDelete: format('http://%s/delete/10:15:SimpleSample/pw', req.headers.host),
                    sampleView: format('http://%s/view/10:15:SimpleSample', req.headers.host),
                    sampleList: format('http://%s/list', req.headers.host),
                    title: 'API Documentation'
                });
            });
        });
    }
);

function getPackageVersion(): string {
    let data = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    return data.version;
}

/**
 * Watch for SIGINT (process interrupt signal) and trigger shutdown
 */
process.on('SIGINT', function onSigInt() {
    // all done, close the db connection
    log.info(__filename, 'onSigInt()', 'Got SIGINT - Exiting application...');
    doShutdown();
});

/**
 * Watch for SIGTERM (process terminate signal) and trigger shutdown
 */
process.on('SIGTERM', function onSigTerm() {
    // all done, close the db connection
    log.info(__filename, 'onSigTerm()', 'Got SIGTERM - Exiting application...');
    doShutdown();
});

/**
 * Gracefully shut down the service
 */
function doShutdown() {
    log.info(__filename, 'doShutDown()', 'Closing HTTP Server connections...');
    httpServer.close();

    log.info(__filename, 'doShutDown()', 'Closing Database connections...');
    mongoDBClient.close();
}

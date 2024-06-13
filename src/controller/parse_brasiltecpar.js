const url = require('url');
const path = require('path');

const PlayerConfiguration = require('../util/player_configuration');
const DashMpdParser = require('../dash_parser');
const logger = require('../util/logger');

const getSegmentTimelineListForDuration = (presentationStartTime, timeShiftBufferDepth, timeLineList, duration) => {
    let durationSum = 0;
    let segmentTimelineList = [];
    const timeShiftBufferDepthInSec = timeShiftBufferDepth / 1000;

    for (let i = timeLineList.length - 1; i >= 0; i--) {
        durationSum += timeLineList[i].end - timeLineList[i].start;
        const durationPerSegment = parseInt(timeLineList[i].end - timeLineList[i].start);

        segmentTimelineList.push({
            start: parseInt(presentationStartTime + timeLineList[i].start + timeShiftBufferDepthInSec),
            stop: parseInt(presentationStartTime + timeLineList[i].end + timeShiftBufferDepthInSec),
            duration: durationPerSegment
        });

        if (durationSum >= duration) {
            break;
        }
    }

    return segmentTimelineList;
};

const getSegmentListForDuration = (presentationStartTime, timeShiftBufferDepth, duration, segmentDuration, startNumber, timescale) => {
    let durationSum = 0;
    let segmentList = [];
    const timeShiftBufferDepthInSec = timeShiftBufferDepth / 1000;

    const segmentDurationInSec = segmentDuration / timescale;
    let segmentNumber = startNumber;

    while (durationSum < duration) {
        const segmentStart = presentationStartTime + durationSum + timeShiftBufferDepthInSec;
        const segmentEnd = segmentStart + segmentDurationInSec;
        durationSum += segmentEnd - segmentStart;
        segmentList.push({
            start: parseInt(segmentStart),
            stop: parseInt(segmentEnd),
            duration: parseInt(segmentDurationInSec)
        });

        durationSum += segmentDurationInSec;
        segmentNumber++;
    }

    return segmentList;
};

const toEpochTime = (presentationStartTime, seconds) => {
    return Math.floor(presentationStartTime + seconds);
};


const ParserBrasiltecpar = async (req, res) => {
    try {
        const {
            url: mpdUrl,
            video: { representation_id: videoRepId },
            audio: { representation_id: audioRepId },
            headers: requestHeader,
            numSegments,
            bufferLength: timeDuration
        } = req.body;

        const parsedUrl = new url.URL(mpdUrl);
        const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;

        const config = PlayerConfiguration.createDefault().manifest;
        const mpdParser = new DashMpdParser();
        mpdParser.configure(config);

        logger.info(`Parsing mpd ${mpdUrl} with rep id ${videoRepId}, ${audioRepId}`);
        await mpdParser.start(mpdUrl, baseUrl, requestHeader);

        const parsedResult = mpdParser.manifest_;
        const presentationStartTime = parsedResult.presentationTimeline.getPresentationStartTime();
        const timeShiftBufferDepth = parsedResult.presentationTimeline.segmentAvailabilityDuration_;
        const nSegments = Math.ceil(timeDuration/parsedResult.presentationTimeline.maxSegmentDuration_);

        if (!parsedResult) {
            return res.json({});
        }

        const targetStream = parsedResult.variants.find(variant => variant.audio.originalId === audioRepId && variant.video.originalId === videoRepId);

        if (!targetStream) {
            return res.json({});
        }

        const audio = targetStream.audio;
        const video = targetStream.video;

        await Promise.all([audio.createSegmentIndex(), video.createSegmentIndex()]);

        const responseData = {
            maxSegmentDuration: parsedResult.presentationTimeline.maxSegmentDuration_,
            timeShiftBufferDepth,
            video: [],
            audio: []
        };

        const processSegmentData = (segmentIndex, segmentList, mediaData, timescale) => {
            if (!segmentList || segmentList.length === 0) {
                // If segmentList is undefined or empty, use segmentIndex directly
                const initSegmentUri = segmentIndex.get(0).initSegmentReference.getUris()[0];
                mediaData.push({
                    segment: 0,
                    type: "initialization",
                    uri: initSegmentUri
                });
        
                // Loop through segmentIndex.indexes_[0].references to generate segment URIs
                for (let i = 0; i < segmentIndex.indexes_[0].references.length; i++) {
                    const reference = segmentIndex.indexes_[0].references[i];
                    const segmentUri = reference.getUrisInner()[0];
                    const segmentNum = toEpochTime(presentationStartTime, reference.startTime / timescale);
        
                    mediaData.push({
                        segment: segmentNum,
                        type: "media",
                        start: toEpochTime(presentationStartTime, reference.startTime / timescale),
                        stop: toEpochTime(presentationStartTime, reference.endTime / timescale),
                        duration: Math.ceil((reference.endTime - reference.startTime) / timescale),
                        uri: segmentUri
                    });
                }
            } else {
                // Process using segmentList
                const initSegmentUri = segmentIndex.get(0).initSegmentReference.getUris()[0];
                mediaData.push({
                    segment: 0,
                    type: "initialization",
                    uri: initSegmentUri
                });
        
                for (let i = segmentList.length; i > 0; i--) {
                    const segmentUri = segmentIndex.get(segmentIndex.indexes_[0].getNumReferences() - i).getUrisInner()[0];
                    const segmentNum = segmentList[i - 1].start;
        
                    mediaData.push({
                        segment: segmentNum,
                        type: "media",
                        start: segmentNum,
                        stop: segmentList[i - 1].stop,
                        duration: segmentList[i - 1].duration,
                        uri: segmentUri
                    });
                }
            }
        };
        

        const videoSegmentIndex = video.segmentIndex;
        const videoTemplateInfo = videoSegmentIndex.indexes_[0]?.templateInfo_;

        let videoSegmentList = [];
        let videoTimescale = 1;
        if (videoTemplateInfo?.timeline) {
            videoSegmentList = getSegmentTimelineListForDuration(presentationStartTime, timeShiftBufferDepth, videoTemplateInfo.timeline, timeDuration);
        } else if (videoTemplateInfo) {
            videoSegmentList = getSegmentListForDuration(presentationStartTime, timeShiftBufferDepth, timeDuration, videoTemplateInfo.segmentDuration, videoTemplateInfo.startNumber, videoTemplateInfo.timescale);
            videoTimescale = videoTemplateInfo.timescale;
        }

        processSegmentData(videoSegmentIndex, videoSegmentList, responseData.video, videoTimescale);

        const audioSegmentIndex = audio.segmentIndex;
        const audioTemplateInfo = audioSegmentIndex.indexes_[0]?.templateInfo_;

        let audioSegmentList = [];
        let audioTimescale = 1;
        if (audioTemplateInfo?.timeline) {
            audioSegmentList = getSegmentTimelineListForDuration(presentationStartTime, timeShiftBufferDepth, audioTemplateInfo.timeline, timeDuration);
        } else if (audioTemplateInfo) {
            audioSegmentList = getSegmentListForDuration(presentationStartTime, timeShiftBufferDepth, timeDuration, audioTemplateInfo.segmentDuration, audioTemplateInfo.startNumber, audioTemplateInfo.timescale);
            audioTimescale = audioTemplateInfo.timescale;
        }

        processSegmentData(audioSegmentIndex, audioSegmentList, responseData.audio, audioTimescale);

        logger.info(`returning ${responseData.video.length} video segments and ${responseData.audio.length} audio ones for latest ${timeDuration} seconds..`);

        // combiine responseData.video.[0] and responseData.video.slice(-nSegments) into a single array responseData.video
        if(!videoTemplateInfo?.timeline){
            videoFiltered = [];
            audioFiltered = [];
            responseData.video = videoFiltered.concat(responseData.video[0], responseData.video.slice(-nSegments));
            responseData.audio = audioFiltered.concat(responseData.audio[0], responseData.audio.slice(-nSegments));
        }
        res.json(responseData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

module.exports = ParserBrasiltecpar;

const jsdom = require("jsdom")
const path = require("path")
const { JSDOM } = jsdom
const download = require('download-pdf')
const moment = require('moment')
const { exec } = require('child_process')
const CronJob = require('cron').CronJob;

const admin = require('firebase-admin')

const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
})

const db = admin.firestore()

const monthMapping = {
    'janeiro': 0,
    'fevereiro': 1,
    'março': 2,
    'abril': 3,
    'maio': 4,
    'junho': 5,
    'julho': 6,
    'agosto': 7,
    'setembro': 8,
    'outubro': 9,
    'novembro': 10,
    'dezembro': 11
}

async function downloadPdf(fileName, pdf) {
    const directory = "./pdfs/"
    var options = {
        directory: directory,
        filename: fileName
    }
    return new Promise((resolve, reject) => {
        download(pdf, options, function (err) {
            if (err) reject(err)
            else resolve(directory + fileName)
        })
    })
}

async function parsePdf(pdfPath, area, destFile) {
    let destPath
    if (destFile) {
        destPath = destFile
    } else {
        destPath = pdfPath.replace('.pdf', '.json')
    }
    const command = `java -Dfile.encoding=UTF8 -jar ${path.resolve('./tabula-1.0.2-jar-with-dependencies.jar')} -a ${area} -p all -f JSON  -o ${destPath} ${pdfPath}`
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) reject(stderr)
            else resolve(destPath)
        })
    })
}

async function saveMenu(data, documentID, name) {
    return db.collection('restaurants').doc(documentID).set({
        name,
        documentID,
        ...data
    })
}

async function parseRUTrindade() {
    const { document } = (await JSDOM.fromURL("http://ru.ufsc.br/ru/")).window
    const rows = Array.from(document.querySelector('table').querySelectorAll('tr')).slice(1)
    const getCellContent = (tr) => Array.from(tr.querySelectorAll('td'))
        .flatMap((td) => td.textContent)
    const contentToDayAndPlates = ([date, ...plates]) => ({
        date: moment(date.split(' ')[0], 'DD.MM.yyyy').add(3, 'hours').toDate(),
        plates: plates.flatMap(i => i.split(/(\n|\s\s)/g)).map(i => i.trim()).filter(i => i !== '')
    })
    const menu = rows.map(getCellContent).map(contentToDayAndPlates)
    await saveMenu({ menu }, 'trindade', 'Campus Trindade')
}

async function parseArarangua() {
    const { document } = (await JSDOM.fromURL("http://ru.ufsc.br/campus-ararangua/")).window
    const pdfUrl = document.querySelector('.content.clearfix ul li a').href
    const filePath = await downloadPdf('ararangua.pdf', pdfUrl)
    const parsedFilePath = await parsePdf(filePath, '66.996,35.003,435.336,801.15')
    const pages = require(parsedFilePath)
    const menu = pages.flatMap(({ data }) => {
        const dataRows = data.map(d => d.map(({ text }) => text))
        const dataColumns = Array(dataRows[0].length).fill().map((_, i) => dataRows.map((r) => r[i]))
        return dataColumns.slice(1).map((column) => {
            const dayIndex = column.findIndex((el) => /\d{2}-\d{2}-\d{2}/.test(el))
            if (dayIndex == -1) return null
            const date = moment(column[dayIndex], 'DD-MM-YY').add(3, 'hours').toDate()
            const offset = column.slice(dayIndex + 1).findIndex((el) => el == '') + dayIndex + 2
            var plates = column.slice(offset)
            plates.forEach((ingredient, index) => {
                if (/\d/.test(ingredient[0]) || ingredient == '') {
                    // first letter is a number
                    plates[index] = ''// mark to remove
                } else if (/[a-z-áàâãéèêíïóôõöúçñ]/.test(ingredient[0])) {
                    // first letter is lowercase
                    plates[index - 1] = `${plates[index - 1]} ${ingredient}`
                    plates[index] = '' // mark to remove
                }
            })
            plates = plates.filter((i) => i != '')
            return {
                date,
                plates
            }
        })
    }).filter((e) => e)
    await saveMenu({ menu }, 'ararangua', 'Campus Araranguá')
}

async function parseCCA() {
    const { document } = (await JSDOM.fromURL("http://ru.ufsc.br/cca-2/")).window
    const pdfUrl = document.querySelector('.content.clearfix ul li a').href
    const filePath = await downloadPdf('cca.pdf', pdfUrl)
    const parsedTitlePath = await parsePdf(filePath, '5.788,12.629,71.037,835.606', './pdfs/header.json')
    const titlePages = require(parsedTitlePath)

    const endDates = titlePages.flatMap(({ data }) => {
        const match = data[0][0].text.match(/Cardápio de \d{2} de .+ a (\d{2}) de (.+) de (\d{4})/)
        if (!match) return []
        const [endDay, endMonth, endYear] = match.slice(1)
        return new Date(parseInt(endYear), monthMapping[endMonth], parseInt(endDay))
    })

    const parsedFilePath = await parsePdf(filePath, '69.0,36.0,500.484,801.095')
    const pages = require(parsedFilePath)
    const menu = pages.flatMap(({ data }, pageIndex) => {
        const endDate = endDates[pageIndex]
        const dataRows = data.map(d => d.map(({ text }) => text))
        const dataColumns = Array(dataRows[0].length).fill().map((_, i) => dataRows.map((r) => r[i]))
        const dayFactor = dataColumns.length - 1
        return dataColumns.map((column, index) => {
            const date = moment(endDate).add('days', - (dayFactor - index)).add(3, 'hours').toDate()
            const offset = column.findIndex((el) => el == '') + 1
            var plates = column.slice(offset).filter(i => !/Saladas|Acompanhamentos|Carnes|Sobremesa/.test(i))
            plates.forEach((ingredient, index) => {
                if (/\d/.test(ingredient[0]) || ingredient == '') {
                    // first letter is a number
                    plates[index] = ''// mark to remove
                } else if (/[a-z-áàâãéèêíïóôõöúçñ]/.test(ingredient[0])) {
                    // first letter is lowercase
                    plates[index - 1] = `${plates[index - 1]} ${ingredient}`
                    plates[index] = '' // mark to remove
                }
            })
            plates = plates.filter((i) => i != '')
            return {
                date,
                plates
            }
        })
    })
    await saveMenu({ menu }, 'cca', 'Campus CCA')
}

async function parseCuritibanos() {
    const { document } = (await JSDOM.fromURL("http://ru.ufsc.br/campus-curitibanos/")).window
    const pdfUrl = document.querySelector('.content.clearfix ul li a').href
    const filePath = await downloadPdf('curitibanos.pdf', pdfUrl)
    const parsedFilePath = await parsePdf(filePath, '102.609,78.004,429.905,814.684')
    const pages = require(parsedFilePath)
    const [menu, menuDinner] = pages.map(({ data }) => {
        const dataRows = data.map(d => d.map(({ text }) => text.replace(/\r/g, ' ')))
        const dataColumns = Array(dataRows[0].length).fill().map((_, i) => dataRows.map((r) => r[i]))
        return dataColumns.map((column) => {
            const match = column[0].match(/(\d{2})\/(\d{2})/g)
            if (!match) return null
            return ({
                date: moment(match, 'DD/MM').add(3, 'hours').toDate(),
                plates: column.slice(1)
            })
        }).filter(e => e)
    })
    await saveMenu({ menu, menuDinner }, 'curitibanos', 'Campus Curitibanos')
}

async function parseJoinvile() {
    const { document } = (await JSDOM.fromURL("http://ru.ufsc.br/campus-joinville/")).window
    const pdfUrl = document.querySelector('.content.clearfix ul li a').href
    const filePath = await downloadPdf('joinvile.pdf', pdfUrl)
    const parsedFilePath = await parsePdf(filePath, '32.094,10.522,460.359,830.225')
    const pages = require(parsedFilePath)
    const menu = pages.flatMap(({ data }) => {
        const dataRows = data.map(d => d.map(({ text }) => text))
        const dataColumns = Array(dataRows[0].length).fill().map((_, i) => dataRows.map((r) => r[i]))
        return dataColumns.slice(1).map((column) => {
            const match = column[1].match(/\d{2}\/\d{2}\/\d{4}/g)
            if (!match) return null
            const date = moment(match, 'DD/MM/YYYY').add(3, 'hours').toDate()
            const plates = column.slice(2).filter((p) => p != '')
            return {
                date,
                plates
            }
        })
    }).filter((m) => m && m.plates.length > 0)
    await saveMenu({ menu }, 'joinvile', 'Campus Joinvile')
}

async function runAll() {
    try {
        await parseRUTrindade()
        console.log('done parseRUTrindade!')
        await parseArarangua()
        console.log('done parseArarangua!')
        await parseCCA()
        console.log('done parseCCA!')
        await parseCuritibanos()
        console.log('done parseCuritibanos!')
        await parseJoinvile()
        console.log('done parseJoinvile!')
    } catch (e) {
        console.error(e)
    }
    console.log('Finished!')
}

new CronJob('0 * * * *', runAll).start();

// runAll()
